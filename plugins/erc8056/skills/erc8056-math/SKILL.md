---
name: erc8056-math
description: Convert Robinhood Stock Token balances and Chainlink prices correctly with the erc8056 library, which implements ERC-8056 uiMultiplier(). Use when computing share-equivalent balances, per-share prices or position values for a tokenized stock, or reviewing code that does.
---

# ERC-8056 multiplier math

`erc8056` is a TypeScript library (npm `erc8056`, Node 20+, peer dependency `viem`). A Stock Token has two units: TOKEN (what `balanceOf` returns, never changes on a corporate action) and SHARE-EQUIVALENT (what the holder economically owns). `uiMultiplier()` is the 1e18-scaled shares-per-token ratio. Install with `npm install erc8056 viem`.

## The two rules

1. A Chainlink Robinhood feed answer is already multiplier-adjusted. It is the price of one TOKEN. To get a per-share price, divide by the multiplier. Never multiply. Value a position as raw balance times the token price.
2. Share-equivalent quantity is `balance * uiMultiplier / 1e18`, truncating. Never print `balanceOf` as a share count.

The types enforce this: `tokenAmount` and `shareAmount` are distinct, and `positionValue` requires a `TokenPrice`, so passing a share price is a compile error (and a `PriceUnitMismatchError` at runtime).

## Functions

- Read: `readUiMultiplier(client, token)`, `readMultiplierState`, `readScheduledAction`, `readShareEquivalent`. A token without `uiMultiplier()` resolves to `1e18`. Transport failures propagate instead of being treated as 1.0.
- Math: `shareEquivalent(amount, multiplier)`, `tokensForShares`, `tokenPriceFromFeed(answer, decimals)`, `sharePriceFromFeed(answer, decimals, multiplier)`, `toSharePrice`, `toTokenPrice`, `positionValue(amount, price, decimals)`, `mulDiv`, `rescale`.
- Constructors: `uiMultiplier(bigint)`, `tokenAmount(bigint)`, `shareAmount(bigint)`, `tokenPrice(bigint, decimals)`, `sharePrice(bigint, decimals)`.
- Format: `toDecimalString`, `formatPrice`, `formatMultiplier`, `formatFixedPoint`, `toFloat`.
- ABIs: `erc8056Abi`, `erc8056ScheduledAbi`, `stockTokenReadAbi`, `erc20ReadAbi`.

The repo also ships a Solidity reference implementation under `contracts/` (`ERC8056.sol`, `ERC8056StockToken.sol`) for writing a token.

## Example

```ts
import { createPublicClient, http } from 'viem'
import { robinhood } from 'viem/chains'
import { readUiMultiplier, shareEquivalent, tokenAmount, toDecimalString } from 'erc8056'

const client = createPublicClient({ chain: robinhood, transport: http() })
const multiplier = await readUiMultiplier(client, '0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5')
const balance = tokenAmount(1_000_000_000_000_000_000_000n)
console.log(toDecimalString(shareEquivalent(balance, multiplier), 18))
```

Pricing: `sharePriceFromFeed(answer, 8, multiplier)` for a per-share price, `tokenPriceFromFeed(answer, 8)` for a per-token price, then `positionValue(rawBalance, tokenPrice, 18)`.

## Notes

- Read the multiplier live. Cached registry snapshots that record `1e18` for every token are out of date.
- Use bigint arithmetic throughout. Do not convert to float until display.
