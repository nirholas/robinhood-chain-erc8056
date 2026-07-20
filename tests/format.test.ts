import { describe, expect, it } from 'vitest'

import {
  formatFixedPoint,
  formatMultiplier,
  formatPrice,
  sharePriceFromFeed,
  toDecimalString,
  toFloat,
  tokenPriceFromFeed,
  uiMultiplier,
  WAD,
} from '../src/index.js'

describe('toDecimalString', () => {
  it('is exact for values a float cannot hold', () => {
    // 2^53 is 9007199254740992; this balance is far past the exact-integer range.
    expect(toDecimalString(123_456_789_012_345_678_901n, 18)).toBe('123.456789012345678901')
  })

  it('trims trailing zeros but keeps significant ones', () => {
    expect(toDecimalString(400_000_000_000_000_000_000n, 18)).toBe('400')
    expect(toDecimalString(100_370_000_000_000_000_000n, 18)).toBe('100.37')
    expect(toDecimalString(1_000_000_000_000_000_001n, 18)).toBe('1.000000000000000001')
  })

  it('pads sub-unit values with leading zeros', () => {
    expect(toDecimalString(1n, 18)).toBe('0.000000000000000001')
    expect(toDecimalString(0n, 18)).toBe('0')
  })

  it('handles zero decimals', () => {
    expect(toDecimalString(42n, 0)).toBe('42')
  })

  it('handles negatives', () => {
    expect(toDecimalString(-1_500_000n, 6)).toBe('-1.5')
  })
})

describe('toFloat', () => {
  it('converts small values faithfully', () => {
    expect(toFloat(31_550_000_000n, 8)).toBe(315.5)
  })

  it('is documented as lossy, and demonstrably is', () => {
    // The exact string keeps all 21 digits; the float cannot.
    const exact = toDecimalString(123_456_789_012_345_678_901n, 18)
    expect(exact).toBe('123.456789012345678901')
    expect(toFloat(123_456_789_012_345_678_901n, 18)).not.toBe(Number(exact.length))
    expect(String(toFloat(123_456_789_012_345_678_901n, 18))).not.toBe(exact)
  })
})

describe('formatPrice', () => {
  it('names the unit so a token price cannot be misread as a share price', () => {
    expect(formatPrice(tokenPriceFromFeed(31_550_000_000n, 8))).toBe('315.5 per token')
    expect(formatPrice(sharePriceFromFeed(31_550_000_000n, 8, uiMultiplier(4n * WAD)))).toBe('78.875 per share')
  })
})

describe('formatMultiplier', () => {
  it('describes what a multiplier means without inventing a split ratio', () => {
    expect(formatMultiplier(WAD)).toBe('1x (no corporate actions applied)')
    expect(formatMultiplier(4n * WAD)).toBe('4x (1 token represents 4 shares)')
    expect(formatMultiplier(WAD / 10n)).toBe('0.1x (1 token represents 0.1 shares)')
  })

  it('reads correctly for the live accrual multipliers on Robinhood Chain mainnet', () => {
    // SGOV and WEEK, as read by scripts/verify-onchain.mjs.
    expect(formatMultiplier(1_000_957_519_890_990_718n)).toBe(
      '1.000957519890990718x (1 token represents 1.000957519890990718 shares)',
    )
    expect(formatMultiplier(2_006_182_524_271_844_660n)).toBe(
      '2.00618252427184466x (1 token represents 2.00618252427184466 shares)',
    )
  })
})

describe('formatFixedPoint', () => {
  it('renders a computed position value', () => {
    expect(formatFixedPoint({ value: 63_100_000_000n, decimals: 8 })).toBe('631')
  })
})
