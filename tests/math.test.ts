import { describe, expect, it } from 'vitest'

import {
  CHAINLINK_FEED_DECIMALS,
  DEFAULT_UI_MULTIPLIER,
  InvalidDecimalsError,
  InvalidMultiplierError,
  MAX_UI_MULTIPLIER,
  NegativeAmountError,
  PriceUnitMismatchError,
  mulDiv,
  positionValue,
  rescale,
  shareAmount,
  shareEquivalent,
  sharePriceFromFeed,
  toSharePrice,
  toTokenPrice,
  tokenAmount,
  tokenPriceFromFeed,
  tokensForShares,
  uiMultiplier,
  WAD,
} from '../src/index.js'
import type { SharePrice, TokenPrice } from '../src/index.js'

const ONE_TOKEN = 10n ** 18n

describe('uiMultiplier', () => {
  it('accepts the identity multiplier', () => {
    expect(uiMultiplier(WAD)).toBe(WAD)
    expect(DEFAULT_UI_MULTIPLIER).toBe(WAD)
  })

  it('rejects zero, because it would erase every share balance', () => {
    expect(() => uiMultiplier(0n)).toThrow(InvalidMultiplierError)
    expect(() => uiMultiplier(0n)).toThrow(/erase every share balance/)
  })

  it('rejects negative multipliers', () => {
    expect(() => uiMultiplier(-1n)).toThrow(InvalidMultiplierError)
  })

  it('accepts the maximum and rejects one above it', () => {
    expect(uiMultiplier(MAX_UI_MULTIPLIER)).toBe(MAX_UI_MULTIPLIER)
    expect(() => uiMultiplier(MAX_UI_MULTIPLIER + 1n)).toThrow(InvalidMultiplierError)
  })

  it('accepts a sub-wei-of-a-share multiplier', () => {
    expect(uiMultiplier(1n)).toBe(1n)
  })
})

describe('amount constructors', () => {
  it('reject negative quantities', () => {
    expect(() => tokenAmount(-1n)).toThrow(NegativeAmountError)
    expect(() => shareAmount(-1n)).toThrow(NegativeAmountError)
  })

  it('accept zero', () => {
    expect(tokenAmount(0n)).toBe(0n)
    expect(shareAmount(0n)).toBe(0n)
  })
})

describe('mulDiv', () => {
  it('is exact for values far beyond 2^53', () => {
    // 1e50 tokens at the maximum multiplier: the intermediate product is 1e86,
    // which overflows uint256 on-chain and Number entirely. bigint is exact.
    expect(mulDiv(10n ** 50n, MAX_UI_MULTIPLIER, WAD)).toBe(10n ** 68n)
  })

  it('truncates toward zero by default', () => {
    expect(mulDiv(4n, WAD / 3n, WAD)).toBe(1n) // 1.333... -> 1
    expect(mulDiv(1n, WAD / 3n, WAD)).toBe(0n) // 0.333... -> 0
  })

  it('rounds up on request', () => {
    expect(mulDiv(4n, WAD / 3n, WAD, 'up')).toBe(2n)
    expect(mulDiv(1n, WAD / 3n, WAD, 'up')).toBe(1n)
  })

  it('rounds to nearest on request, with halves away from zero', () => {
    expect(mulDiv(1n, 4n, 10n, 'nearest')).toBe(0n) // 0.4 -> 0
    expect(mulDiv(1n, 5n, 10n, 'nearest')).toBe(1n) // 0.5 -> 1
    expect(mulDiv(1n, 6n, 10n, 'nearest')).toBe(1n) // 0.6 -> 1
  })

  it('never rounds an exact quotient', () => {
    for (const rounding of ['down', 'up', 'nearest'] as const) {
      expect(mulDiv(6n, 2n, 3n, rounding)).toBe(4n)
    }
  })

  it('throws rather than returning Infinity on a zero denominator', () => {
    expect(() => mulDiv(1n, 1n, 0n)).toThrow(RangeError)
  })
})

describe('rule 2: shareEquivalent', () => {
  it('is the identity at a 1.0 multiplier', () => {
    expect(shareEquivalent(tokenAmount(100n * ONE_TOKEN), uiMultiplier(WAD))).toBe(100n * ONE_TOKEN)
  })

  it('quadruples share count on a 4:1 split while the balance is unchanged', () => {
    const balance = tokenAmount(100n * ONE_TOKEN)
    expect(shareEquivalent(balance, uiMultiplier(4n * WAD))).toBe(400n * ONE_TOKEN)
    expect(balance).toBe(100n * ONE_TOKEN)
  })

  it('tenths the share count on a 1:10 reverse split', () => {
    expect(shareEquivalent(tokenAmount(100n * ONE_TOKEN), uiMultiplier(WAD / 10n))).toBe(10n * ONE_TOKEN)
  })

  it('handles a fractional dividend multiplier exactly', () => {
    // 0.37% reinvested dividend on 100 tokens is 100.37 shares.
    expect(shareEquivalent(tokenAmount(100n * ONE_TOKEN), uiMultiplier(1_003_700_000_000_000_000n))).toBe(
      100_370_000_000_000_000_000n,
    )
  })

  it('matches the on-chain balanceOfUI truncation on a sub-unit remainder', () => {
    // The Solidity suite asserts the identical numbers in
    // test_RoundingIsAlwaysTowardZero.
    const third = uiMultiplier(WAD / 3n)
    expect(shareEquivalent(tokenAmount(1n), third)).toBe(0n)
    expect(shareEquivalent(tokenAmount(4n), third)).toBe(1n)
  })

  it('never over-sums the total when every holder truncates', () => {
    const third = uiMultiplier(WAD / 3n)
    const holders = [tokenAmount(2n), tokenAmount(2n), tokenAmount(2n)]
    const summed = holders.reduce((acc, h) => acc + shareEquivalent(h, third), 0n)
    const total = shareEquivalent(tokenAmount(6n), third)
    expect(summed).toBeLessThanOrEqual(total)
  })

  it('survives a huge multiplier without overflow', () => {
    expect(shareEquivalent(tokenAmount(10n ** 50n), uiMultiplier(MAX_UI_MULTIPLIER))).toBe(10n ** 68n)
  })

  it('is zero for a zero balance at any multiplier', () => {
    expect(shareEquivalent(tokenAmount(0n), uiMultiplier(MAX_UI_MULTIPLIER))).toBe(0n)
  })
})

describe('tokensForShares', () => {
  it('inverts shareEquivalent on exact values', () => {
    const m = uiMultiplier(4n * WAD)
    expect(tokensForShares(shareAmount(400n * ONE_TOKEN), m)).toBe(100n * ONE_TOKEN)
  })

  it('never manufactures tokens on a lossy round trip', () => {
    const m = uiMultiplier(WAD / 3n)
    const balance = tokenAmount(1_000_000_007n)
    const back = tokensForShares(shareEquivalent(balance, m), m)
    expect(back).toBeLessThanOrEqual(balance)
  })

  it('rounds up when the caller must cover at least N shares', () => {
    const m = uiMultiplier(3n * WAD)
    expect(tokensForShares(shareAmount(4n), m, 'down')).toBe(1n) // 1.333 -> 1, one short
    expect(tokensForShares(shareAmount(4n), m, 'up')).toBe(2n) // covers the full 4 shares
  })
})

describe('rule 1: pricing', () => {
  const answer = 31_550_000_000n // $315.50 at 8 decimals

  it('reads a feed answer as a token price with no adjustment', () => {
    const price = tokenPriceFromFeed(answer)
    expect(price).toEqual({ unit: 'token', value: answer, decimals: CHAINLINK_FEED_DECIMALS })
  })

  it('divides by the multiplier to reach the share price', () => {
    // After a 4:1 split, $315.50 per token is $78.875 per share.
    const price = sharePriceFromFeed(answer, 8, uiMultiplier(4n * WAD))
    expect(price).toEqual({ unit: 'share', value: 7_887_500_000n, decimals: 8 })
  })

  it('leaves the share price equal to the token price at a 1.0 multiplier', () => {
    expect(sharePriceFromFeed(answer, 8, uiMultiplier(WAD)).value).toBe(answer)
  })

  it('raises the share price above the token price after a reverse split', () => {
    const price = sharePriceFromFeed(answer, 8, uiMultiplier(WAD / 10n))
    expect(price.value).toBe(315_500_000_000n) // $3155.00 per share
  })

  it('round trips token -> share -> token', () => {
    const m = uiMultiplier(4n * WAD)
    const token = tokenPriceFromFeed(answer)
    expect(toTokenPrice(toSharePrice(token, m), m).value).toBe(answer)
  })

  it('refuses to convert a share price as if it were a token price', () => {
    const share = sharePriceFromFeed(answer, 8, uiMultiplier(4n * WAD))
    expect(() => toSharePrice(share as unknown as TokenPrice, uiMultiplier(4n * WAD))).toThrow(PriceUnitMismatchError)
    expect(() => toSharePrice(share as unknown as TokenPrice, uiMultiplier(4n * WAD))).toThrow(/divides twice/)
  })

  it('refuses to convert a token price as if it were a share price', () => {
    const token = tokenPriceFromFeed(answer)
    expect(() => toTokenPrice(token as unknown as SharePrice, uiMultiplier(4n * WAD))).toThrow(PriceUnitMismatchError)
  })

  it('rejects a nonsense decimals argument', () => {
    expect(() => tokenPriceFromFeed(answer, -1)).toThrow(InvalidDecimalsError)
    expect(() => tokenPriceFromFeed(answer, 1.5)).toThrow(InvalidDecimalsError)
    expect(() => tokenPriceFromFeed(answer, 200)).toThrow(InvalidDecimalsError)
  })
})

describe('positionValue', () => {
  const answer = 31_550_000_000n

  it('values a position with the raw balance, not the share equivalent', () => {
    const value = positionValue(tokenAmount(2n * ONE_TOKEN), tokenPriceFromFeed(answer), 18)
    expect(value).toEqual({ value: 63_100_000_000n, decimals: 8 }) // $631.00
  })

  it('is unchanged by a corporate action, which is the whole point of rule 1', () => {
    const balance = tokenAmount(2n * ONE_TOKEN)
    const before = positionValue(balance, tokenPriceFromFeed(answer), 18)

    // A 4:1 split does not move the token price, and does not move the balance.
    const after = positionValue(balance, tokenPriceFromFeed(answer), 18)
    expect(after).toEqual(before)

    // Whereas the (wrong) multiplier-applied version inflates the position 4x.
    const wrong = positionValue(
      tokenAmount(shareEquivalent(balance, uiMultiplier(4n * WAD))),
      tokenPriceFromFeed(answer),
      18,
    )
    expect(wrong.value).toBe(before.value * 4n)
  })

  it('refuses a share price at the type level and at runtime', () => {
    const share = sharePriceFromFeed(answer, 8, uiMultiplier(4n * WAD))
    expect(() => positionValue(tokenAmount(ONE_TOKEN), share as unknown as TokenPrice, 18)).toThrow(
      PriceUnitMismatchError,
    )
  })

  it('handles a 6-decimal token against an 8-decimal feed', () => {
    // 1000 units of a 6-decimal token at $315.50.
    const value = positionValue(tokenAmount(1_000_000_000n), tokenPriceFromFeed(answer), 6)
    expect(value).toEqual({ value: 31_550_000_000_000n, decimals: 8 })
  })
})

describe('rescale', () => {
  it('is exact when scaling up', () => {
    expect(rescale(31_550_000_000n, 8, 18)).toBe(315_500_000_000_000_000_000n)
  })

  it('truncates when scaling down by default', () => {
    expect(rescale(31_550_000_001n, 8, 6)).toBe(315_500_000n)
  })

  it('rounds up on request when scaling down', () => {
    expect(rescale(31_550_000_001n, 8, 6, 'up')).toBe(315_500_001n)
  })

  it('is the identity for equal scales', () => {
    expect(rescale(12345n, 8, 8)).toBe(12345n)
  })

  it('handles the 18 to 6 gap that Stock Tokens and USDG create', () => {
    expect(rescale(ONE_TOKEN, 18, 6)).toBe(1_000_000n)
    expect(rescale(1n, 18, 6)).toBe(0n) // one wei of an 18dp token is sub-unit in USDG
  })

  it('rejects nonsense scales', () => {
    expect(() => rescale(1n, -1, 6)).toThrow(InvalidDecimalsError)
    expect(() => rescale(1n, 6, 99)).toThrow(InvalidDecimalsError)
  })
})
