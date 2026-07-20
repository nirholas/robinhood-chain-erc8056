# erc8056

**Reference implementation and canonical explainer for ERC-8056 (`uiMultiplier()`), the corporate-actions standard behind Robinhood's Stock Tokens on [Robinhood Chain](https://docs.robinhood.com/chain/) (chain ID 4663).**

Two things ship here: an auditable Solidity reference implementation, and the exact-bigint
TypeScript library that makes integrating it hard to get wrong. If you display a portfolio,
price a token, or index transfers of a tokenized equity, this is the standard you have to
handle, and there are exactly two rules you have to get right.

Docs: **https://nirholas.github.io/erc8056/**

## The problem

A tokenized share has to survive corporate actions. When an issuer runs a 4:1 split, one
share becomes four. Neither obvious on-chain answer works:

- **Mint to every holder.** Needs unbounded iteration over the holder set, and is simply
  impossible for tokens sitting in AMM pools, vaults, and bridges that were never built to
  receive an airdrop.
- **Rebase.** Redefine `balanceOf` so every balance scales. This breaks every cached
  balance, every AMM invariant, and every accounting system that assumes `transfer(x)` moves
  exactly `x`. Rebasing tokens are notorious for exactly this reason.

ERC-8056 takes a third path. Balances are immutable ledger units, and a single global
`uiMultiplier()` records how many **shares** one **token** currently represents. A 4:1 split
multiplies that number by four. No balance moves, no `Transfer` event fires, no AMM
invariant shifts, and every integration that never opted in keeps working on unchanged
numbers instead of silently computing wrong ones.

The cost of that design is that the token now has two units, and mixing them up is the whole
integration risk:

| Unit | What it is | Changes on a split? |
|---|---|---|
| **TOKEN** | What `balanceOf` returns, what `transfer` moves, what a pool holds | No |
| **SHARE-EQUIVALENT** | What the holder economically owns, what a statement prints | Yes |

## The two rules

**Rule 1. A Chainlink Robinhood feed answer is already multiplier-adjusted.** It is the price
of one TOKEN, not one share. To get the share price, **divide** by the multiplier. Never
multiply. To value a position, multiply the **raw** balance by the feed price.

**Rule 2. Share-equivalent quantities are `balance * uiMultiplier / 1e18`,** truncating. The
raw `balanceOf` value stops being a share count the moment a corporate action lands.

Both rules are enforced by the type system in this package, not merely documented.
`TokenAmount` and `ShareAmount` are distinct types; `TokenPrice` and `SharePrice` carry a
runtime-inspectable `unit` tag; and `positionValue` demands a `TokenPrice`, so pairing a
share price with a raw balance does not compile.

## Evidence: this is live, not theoretical

The standard is easy to dismiss because 93 of the 95 canonical Stock Tokens sit at exactly
`1e18` today. Two do not, and they prove the mechanism is load-bearing right now:

```bash
npm run verify:onchain
```

```
Robinhood Chain mainnet (chain 4663) via https://rpc.mainnet.chain.robinhood.com
Block 14994060

Checking ERC-8056 invariants across all 95 canonical Stock Tokens...
  95/95 tokens implement uiMultiplier()
  totalSupplyUI() == truncating mulDiv(totalSupply, uiMultiplier, 1e18) on every one of them

Tokens with a corporate action already applied (uiMultiplier != 1.0):
  SGOV   0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5  uiMultiplier() = 1000957519890990718
         = 1.000957519890990718 shares per token   iShares 0-3 Month Treasury Bond - Robinhood Token
  WEEK   0xc93a8c440CEa26D7445dF01729f193b27965099f  uiMultiplier() = 2006182524271844660
         = 2.00618252427184466 shares per token   Roundhill Weekly T-Bill ETF - Robinhood Token

Rule 1 on live data (SGOV, feed 0xa0DF4ee0fFf975306345875E3548Fcc519577A11):
  Chainlink answer            10068131213 (100.68131213 per TOKEN)
  divided by the multiplier   100.58499999 per SHARE
  the wrong way (multiply)    100.77771648 <- overstates the share price

Pre-ERC-8056 fallback (a real contract with no uiMultiplier()):
  WETH   0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73  implemented = false, resolves to 1000000000000000000 [OK]

PASS: 95 tokens verified, 2 with a live corporate action applied, totalSupplyUI() matches
truncating mulDiv everywhere, and a non-8056 contract resolves to 1e18 without throwing.
```

Three things that output establishes:

1. **Rule 2 is the chain's own arithmetic.** `totalSupplyUI()` read from each contract equals
   `mulDiv(totalSupply, uiMultiplier, 1e18)` computed locally, on all 95 tokens, with
   truncation. If this package rounded differently it would disagree with the chain here.
2. **The multipliers that are not 1.0 are accruals, not splits.** SGOV and WEEK are T-bill
   funds whose multipliers grow as income is distributed. Their holders own more shares than
   their balances say, continuously, not just after some future split announcement. Any
   tracker printing `balanceOf` as a share count is already wrong on these two today.
3. **The fallback works against a real contract.** WETH on chain 4663 has no `uiMultiplier()`,
   and `readMultiplierState` reports `implemented: false` with a 1e18 multiplier rather than
   throwing or inventing a number.

> Note on the 1.0 assumption: registry snapshots of this chain commonly record
> `uiMultiplierAtGeneration` as `1000000000000000000` for every token. That was true when
> those snapshots were taken. It is not true now. Read the multiplier live.

## Install

```bash
npm install erc8056 viem
```

Node >= 20. `viem` is a peer dependency, never bundled.

## Quickstart

### If you display a portfolio

Read the multiplier and convert. Never print `balanceOf` as a share count.

```ts
import { createPublicClient, http } from 'viem'
import { robinhood } from 'viem/chains'
import { readUiMultiplier, shareEquivalent, tokenAmount, toDecimalString } from 'erc8056'

const client = createPublicClient({ chain: robinhood, transport: http() })
const SGOV = '0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5'

const multiplier = await readUiMultiplier(client, SGOV)
const balance = tokenAmount(1_000_000_000_000_000_000_000n) // 1000 SGOV tokens

console.log(toDecimalString(balance, 18))                             // '1000' <- tokens
console.log(toDecimalString(shareEquivalent(balance, multiplier), 18)) // '1000.957519890990718' <- shares
```

`readUiMultiplier` resolves a token that predates the standard to `1e18` instead of throwing,
and **propagates transport failures** rather than absorbing them. That distinction is the
point of the function: answering "the multiplier is 1.0" because an RPC timed out would
misreport every position on a token that has accrued.

### If you price a token

```ts
import {
  formatPrice,
  positionValue,
  sharePriceFromFeed,
  tokenAmount,
  tokenPriceFromFeed,
  uiMultiplier,
} from 'erc8056'

const answer = 10_068_131_213n                             // live SGOV Chainlink answer, 8 decimals
const multiplier = uiMultiplier(1_000_957_519_890_990_718n)

const perToken = tokenPriceFromFeed(answer, 8)             // rule 1: no adjustment
const perShare = sharePriceFromFeed(answer, 8, multiplier) // rule 1: DIVIDE

console.log(formatPrice(perToken))  // '100.68131213 per token'
console.log(formatPrice(perShare))  // '100.58499999 per share'

// Value a position with the RAW balance and the TOKEN price.
const value = positionValue(tokenAmount(10n * 10n ** 18n), perToken, 18)
console.log(value)                  // { value: 100681312130n, decimals: 8 }  ->  $1006.81312130
```

Passing `perShare` to `positionValue` is a compile error, and a `PriceUnitMismatchError` at
runtime if you force it past the type checker.

### If you write the token

```solidity
import {ERC8056} from "erc8056/contracts/ERC8056.sol";

contract MyStockToken is ERC8056 {
    address public immutable transferAgent;

    constructor(address agent) ERC8056("My Stock Token", "MST") {
        transferAgent = agent;
    }

    function _authorizeCorporateAction() internal view override {
        require(msg.sender == transferAgent, "not the transfer agent");
    }

    /// A 4:1 split. No balance moves, no Transfer fires.
    function split() external {
        _applySplit(4, 1);
    }
}
```

See [`contracts/ERC8056StockToken.sol`](./contracts/ERC8056StockToken.sol) for the complete
deployable version with role separation, issuance, and ERC-165.

## A worked example: the 4:1 split

Alice holds 100 tokens. The issuer runs a 4:1 split. The feed answer is $315.50 before and
after, because it prices the token, not the share.

| | Before | After | Moved? |
|---|---|---|---|
| `balanceOf(alice)` | 100 | **100** | no |
| `uiMultiplier()` | `1e18` | **`4e18`** | yes |
| `balanceOfUI(alice)` (shares) | 100 | **400** | yes |
| `totalSupply()` | unchanged | unchanged | no |
| Chainlink answer (per token) | $315.50 | **$315.50** | no |
| Share price (answer / multiplier) | $315.50 | **$78.875** | yes |
| Alice's position value | $31,550 | **$31,550** | no |
| `Transfer` events emitted | | **none** | |

The two failure modes this table rules out:

- A tracker that prints `balanceOf` as shares says Alice owns 100 shares after the split.
  She owns 400.
- A pricer that multiplies the feed answer by the multiplier values her position at
  $126,200, four times the truth.

Both are asserted in the test suites: `test_ForwardSplit_MovesSharesNotBalances` in Solidity
and `positionValue > is unchanged by a corporate action` in TypeScript.

## Repository layout

| Path | What it is |
|---|---|
| [`contracts/IERC8056.sol`](./contracts/IERC8056.sol) | The interface, with the reasoning for each member in natspec |
| [`contracts/ERC8056.sol`](./contracts/ERC8056.sol) | Abstract reference implementation over a standard ERC-20 |
| [`contracts/ERC8056StockToken.sol`](./contracts/ERC8056StockToken.sol) | Deployable example: role separation, issuance, ERC-165 |
| [`test/ERC8056.t.sol`](./test/ERC8056.t.sol) | Foundry unit and fuzz suite, 31 tests |
| `src/` | The `erc8056` TypeScript package |
| [`scripts/verify-onchain.mjs`](./scripts/verify-onchain.mjs) | Live mainnet invariant check (the output above) |
| [`examples/`](./examples) | Runnable `tsx` scripts against live mainnet |
| [`INTEGRATION.md`](./INTEGRATION.md) | Checklist for wiring this into an existing product |

## API reference

### Reading the chain

| Export | What it does |
|---|---|
| `readUiMultiplier(client, token, options?)` | Read `uiMultiplier()`. Resolves a pre-8056 token to `1e18`; propagates transport failures. |
| `readMultiplierState(client, token, options?)` | Same, plus an `implemented` flag so a UI can label a pre-8056 token honestly. |
| `readScheduledAction(client, token, options?)` | The pending corporate action, or `null` when nothing is scheduled or the extension is absent. |
| `readShareEquivalent(client, token, owner, options?)` | Share-equivalent balance. Prefers on-chain `balanceOfUI`, falls back to `balanceOf` x multiplier. |
| `isMissingFunctionError(error)` | `true` only when the chain executed the call and it produced no result. The transport-vs-revert discriminator. |
| `ReadMultiplierOptions` | `{ blockNumber?: bigint }` for reading at a historical block. |

### Quantities (rule 2)

| Export | What it does |
|---|---|
| `shareEquivalent(balance, multiplier, rounding?)` | `balance * multiplier / 1e18`, truncating. Matches on-chain `balanceOfUI` exactly. |
| `tokensForShares(shares, multiplier, rounding?)` | The inverse. Pass `'up'` when the result must cover at least `shares`. |
| `tokenAmount(v)` / `shareAmount(v)` | Validating constructors for the two distinct quantity types. |
| `uiMultiplier(v)` | Validating constructor. Rejects zero and anything above `MAX_UI_MULTIPLIER`. |

### Prices (rule 1)

| Export | What it does |
|---|---|
| `tokenPriceFromFeed(answer, decimals?)` | Read a Chainlink answer as what it is: a token price. Applies no adjustment, on purpose. |
| `sharePriceFromFeed(answer, decimals, multiplier, rounding?)` | `answer * 1e18 / multiplier`. The underlying share price. |
| `toSharePrice(tokenPrice, multiplier, rounding?)` | Convert token price to share price. Throws on a share price. |
| `toTokenPrice(sharePrice, multiplier, rounding?)` | The inverse, and the only correct place to multiply a price by the multiplier. |
| `positionValue(balance, tokenPrice, tokenDecimals?, rounding?)` | `balance * tokenPrice`, no multiplier. Requires a `TokenPrice` at the type level. |

### Fixed-point primitives

| Export | What it does |
|---|---|
| `mulDiv(a, b, denominator, rounding?)` | Exact `a * b / denominator`. Rounding is explicit and never implicit. |
| `rescale(value, from, to, rounding?)` | Move between decimal scales exactly. The fix for the 18-vs-8-vs-6 mismatch. |
| `WAD`, `MAX_UI_MULTIPLIER`, `DEFAULT_UI_MULTIPLIER` | `1e18`, `1e36`, and the pre-8056 fallback value. |
| `CHAINLINK_FEED_DECIMALS`, `STOCK_TOKEN_DECIMALS`, `UI_MULTIPLIER_DECIMALS` | `8`, `18`, `18`. |

### Formatting (lossy or display-only, quarantined in `src/format.ts`)

| Export | What it does |
|---|---|
| `toDecimalString(value, decimals)` | Exact decimal string. Prefer this for display. |
| `toFloat(value, decimals)` | `number` conversion. **Lossy above 2^53.** Never feed the result back into the math. |
| `formatPrice(price)` | Renders with the unit spelled out, so a log line cannot be misread. |
| `formatMultiplier(m)` | Plain-language reading of a multiplier. |
| `formatFixedPoint(amount)` | Exact decimal string for a computed value. |

### ABI

| Export | What it does |
|---|---|
| `erc8056Abi` | Exactly `IERC8056`: `uiMultiplier`, `balanceOfUI`, `totalSupplyUI`, `UIMultiplierUpdated`. |
| `erc8056ScheduledAbi` | The optional extension: `newUIMultiplier`, `effectiveAt`. |
| `erc20ReadAbi`, `stockTokenReadAbi` | The ERC-20 read surface, and the two combined. |
| `UI_MULTIPLIER_SELECTOR` etc. | `0xa60bf13d`, `0x437a9958`, `0x9bea6429`. |

`tests/abi.test.ts` asserts every fragment above against the artifact produced by really
compiling `contracts/` with solc, so the TypeScript and the Solidity cannot drift apart
without a test failing.

## Verification

```bash
npm run build:contracts   # compile contracts/ with solc 0.8.30, write artifacts/
npm test                  # build:contracts, then 80 vitest tests
npm run test:sol          # 31 Foundry tests, incl. 2 fuzz suites at 256 runs each
npm run typecheck         # tsc --noEmit
npm run build             # tsup: esm + cjs + dts
npm run verify:onchain    # live mainnet invariant check
```

The Solidity suite covers forward splits, reverse splits, fractional dividend multipliers,
rounding direction, the truncation invariant that keeps summed holder shares below the share
supply, scheduling and maturation, authorization, the 512-bit intermediate product, and the
pre-8056 case. Foundry is required only for `test:sol`, and pulls `forge-std` as a git
submodule (`git submodule update --init`). `npm test` compiles the same contracts with the
`solc` npm package and needs nothing but `npm install`.

## Limits and caveats

- **The multiplier is time-dependent by design.** A scheduled action flips `uiMultiplier()`
  at its `effectiveAt` timestamp with no transaction. Cache it with that in mind, or read at
  an explicit `blockNumber` when reconciling historical statements.
- **Ratio composition truncates.** `_applySplit(1, 3)` then `_applySplit(3, 1)` lands one wei
  below where you started. Correct a multiplier with the exact-value setter, not by composing
  ratios. Asserted in `test_ComposedRatiosTruncate_DocumentedBehaviour`.
- **`MAX_UI_MULTIPLIER` is a deliberate policy choice, not part of the wire format.** The
  reference implementation caps at `1e36` so a fat-fingered admin cannot push the multiplier
  into a range where `balanceOfUI` reverts on overflow for ordinary holders. The canonical
  Robinhood tokens are not obliged to share that bound.
- **Canonical Stock Tokens do not implement ERC-165.** They report neither interface id, so
  discovery means probing `uiMultiplier()` and treating a revert as 1e18. The reference
  implementation does implement ERC-165, but do not rely on it when reading tokens you did
  not deploy.
- **`erc8056` reads. It does not write.** There are no transaction helpers for applying a
  corporate action, because on a real security token that path belongs to the issuer's
  transfer agent behind their own controls, not to a generic npm package.
- **The `hoodchain` dependency is dev-only.** It supplies the token registry for
  `scripts/verify-onchain.mjs` and `examples/`. The published `erc8056` package has no
  runtime dependency on it, and no opinion about which tokens exist.

## License

Proprietary, all rights reserved. See [LICENSE](./LICENSE).
