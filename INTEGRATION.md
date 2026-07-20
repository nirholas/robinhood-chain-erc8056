# Integrating ERC-8056

A checklist for wiring corporate-action correctness into an existing product. Written for the
case where you already have a working integration with Robinhood Chain Stock Tokens and need
to know what breaks the first time an issuer runs a split or a fund accrues income.

The short version: **two of the 95 canonical Stock Tokens already have a multiplier that is
not 1.0.** If your product shows balances or prices for SGOV or WEEK, it is already wrong.
Everything else on the chain is one corporate action away from the same bug.

## 1. Find every place you treat a balance as a share count

Grep for `balanceOf` on Stock Token addresses. For each hit, decide which unit the surrounding
code actually means:

| If the code is... | It wants | Fix |
|---|---|---|
| Showing "you own N shares" | SHARE-EQUIVALENT | `shareEquivalent(balance, multiplier)` |
| Computing a transfer amount | TOKEN | leave it alone |
| Computing an allowance or approval | TOKEN | leave it alone |
| Summing a portfolio for display | SHARE-EQUIVALENT | convert each position |
| Multiplying by a Chainlink price | TOKEN | leave it alone (see step 3) |
| Reconciling against a brokerage statement | SHARE-EQUIVALENT | convert, and pin the block |

The rule of thumb: anything that moves on-chain is a TOKEN quantity. Anything a human reads as
"shares" is a SHARE-EQUIVALENT quantity.

```ts
import { readUiMultiplier, shareEquivalent, tokenAmount } from 'erc8056'

const multiplier = await readUiMultiplier(client, token)
const shares = shareEquivalent(tokenAmount(balance), multiplier)
```

## 2. Handle the tokens that do not implement the standard

Canonical Stock Tokens do not implement ERC-165, so you cannot ask them whether they support
ERC-8056. You have to probe `uiMultiplier()` and interpret the failure.

Use `readMultiplierState` rather than a hand-rolled try/catch. The distinction it draws is the
one that matters:

```ts
import { readMultiplierState } from 'erc8056'

const { multiplier, implemented } = await readMultiplierState(client, token)
// implemented === false  ->  pre-ERC-8056 token, multiplier is 1e18, balances already are shares
// a transport failure    ->  THROWS, does not silently return 1e18
```

**Do not write this:**

```ts
// WRONG: an RPC timeout becomes a plausible-looking wrong answer.
let multiplier = 10n ** 18n
try {
  multiplier = await client.readContract({ ...})
} catch {}
```

A missing function and an unreachable RPC produce the same `catch` here, and the second one
silently misreports every position on a token that has accrued. `isMissingFunctionError` is
exported if you need the discriminator in your own code.

## 3. Fix your pricing

If you consume Chainlink's Robinhood feeds, the answer is **already multiplier-adjusted**. It
prices one TOKEN.

```ts
import { positionValue, sharePriceFromFeed, tokenPriceFromFeed } from 'erc8056'

const [, answer] = await client.readContract({ address: feed, abi, functionName: 'latestRoundData' })

const perToken = tokenPriceFromFeed(answer, 8)                 // the answer, unmodified
const perShare = sharePriceFromFeed(answer, 8, multiplier)     // DIVIDED by the multiplier
const value = positionValue(tokenAmount(balance), perToken, 18) // RAW balance x TOKEN price
```

Two checks to run against your existing code:

- Do you ever multiply a feed answer by `uiMultiplier`? That is the bug. It overstates by the
  multiplier.
- Do you value positions with a share-equivalent balance and a feed price? Same bug, same
  factor.

`positionValue` requires a `TokenPrice` at the type level, so once you route valuation through
it the mistake stops compiling.

## 4. Index the corporate action, not just transfers

A corporate action emits `UIMultiplierUpdated` and **no `Transfer` event at all**. An indexer
that reconstructs balances from `Transfer` logs stays correct (balances genuinely did not
move), but any share count or historical statement it derives will drift from reality after
the first action.

Subscribe to the event:

```ts
import { erc8056Abi } from 'erc8056'

client.watchContractEvent({
  address: token,
  abi: erc8056Abi,
  eventName: 'UIMultiplierUpdated',
  onLogs: (logs) => { /* re-derive every share count for this token */ },
})
```

Note that the canonical Robinhood tokens predate this repository's event shape. Treat
`UIMultiplierUpdated` as authoritative for tokens you deploy from `contracts/`, and poll
`uiMultiplier()` for tokens you do not control.

## 5. Decide your caching policy

`uiMultiplier()` is time-dependent by design. A scheduled action flips the returned value at
its `effectiveAt` timestamp with **no transaction**, so a multiplier cached across that
boundary goes stale without any on-chain event to invalidate it.

Three workable policies, in order of preference:

1. **Read it with the balance, every time.** One extra `multicall` entry. This is what
   `examples/portfolio.ts` does and what almost every product should do.
2. **Cache with a short TTL and check `readScheduledAction`.** If a pending action exists,
   expire the cache at `effectiveAt`.
3. **Pin a block.** For statements and reconciliation, pass `{ blockNumber }` so the
   multiplier matches the balances you read at that block. Never mix a current multiplier with
   a historical balance.

## 6. Test against a non-1.0 multiplier before you ship

The reason this bug class ships so easily is that every code path looks correct while the
multiplier is 1.0, and 93 of 95 tokens are at 1.0 today. Test against one that is not:

| Token | Address | Multiplier |
|---|---|---|
| SGOV | `0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5` | `1000957519890990718` |
| WEEK | `0xc93a8c440CEa26D7445dF01729f193b27965099f` | `2006182524271844660` |

WEEK is the better test: at 2.006 shares per token the divergence is large enough to be
obvious in a UI, so a wrong conversion is visible rather than a rounding-sized discrepancy.

Run `npm run verify:onchain` for the current values. They move as income accrues.

## 7. If you are deploying your own token

Use `contracts/ERC8056.sol` as the base and implement `_authorizeCorporateAction`. Points
worth deciding explicitly:

- **Separate the corporate-action role from the issuance role.** A bad mint dilutes. A bad
  multiplier misprices every holder's position at once, in every integration reading the
  token, instantly. `ERC8056StockToken` separates them for this reason.
- **Prefer scheduling over immediate application.** `_scheduleSplit(n, d, effectiveAt)` lets
  integrators read the pending action and warn users before it lands.
- **Correct a multiplier with the exact-value setter, not by composing ratios.** Composed
  ratio splits truncate: `(1,3)` then `(3,1)` lands one wei below where you started.
- **Implement ERC-165** even though the canonical tokens do not. It costs nothing and makes
  discovery possible for anything deployed after you.

## Reference

- Full API table and worked example: [README.md](./README.md)
- The explainer, with diagrams: <https://nirholas.github.io/erc8056/>
- Solidity reference: [`contracts/`](./contracts)
- Live invariant check: [`scripts/verify-onchain.mjs`](./scripts/verify-onchain.mjs)
