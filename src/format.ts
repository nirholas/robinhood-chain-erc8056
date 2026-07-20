/**
 * Float and string helpers, quarantined.
 *
 * Everything in this file returns a `number` or a `string` and is therefore
 * LOSSY or DISPLAY-ONLY. None of it belongs in a calculation. The separation is
 * deliberate: a 1e18-scaled balance exceeds the 2^53 exact-integer range of a
 * JavaScript `number` at around 9.007 tokens, so converting to float and back is
 * not a rounding nuisance, it silently corrupts ordinary position sizes.
 *
 * Use these at the very edge, to render. Never to compute.
 */

import type { FixedPoint, Price, PriceUnit } from './types.js'

/**
 * Render a scaled integer as a decimal string. EXACT: no precision is lost,
 * because the result is a string rather than a float.
 *
 * This is the safe formatter. Prefer it over {@link toFloat} everywhere a value
 * is only being displayed.
 *
 * @param value - The scaled integer.
 * @param decimals - Its scale.
 *
 * @example
 * ```ts
 * import { toDecimalString } from 'erc8056'
 *
 * toDecimalString(400_000_000_000_000_000_000n, 18) // '400'
 * toDecimalString(100_370_000_000_000_000_000n, 18) // '100.37'
 * ```
 */
export function toDecimalString(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString()

  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '')

  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

/**
 * Convert a scaled integer to a `number`. LOSSY above 2^53.
 *
 * Provided because charting libraries and spreadsheets need floats, and doing
 * this conversion badly by hand is worse than doing it here once. Do not feed
 * the result back into any of the math functions.
 *
 * @param value - The scaled integer.
 * @param decimals - Its scale.
 */
export function toFloat(value: bigint, decimals: number): number {
  return Number(toDecimalString(value, decimals))
}

/**
 * Render a {@link FixedPoint} as an exact decimal string.
 */
export function formatFixedPoint(amount: FixedPoint): string {
  return toDecimalString(amount.value, amount.decimals)
}

/**
 * Render a price with its unit spelled out, so a log line or a screenshot can
 * never be misread as the other unit.
 *
 * @example
 * ```ts
 * import { formatPrice, tokenPriceFromFeed } from 'erc8056'
 *
 * formatPrice(tokenPriceFromFeed(31_550_000_000n, 8)) // '315.5 per token'
 * ```
 */
export function formatPrice<U extends PriceUnit>(price: Price<U>): string {
  return `${toDecimalString(price.value, price.decimals)} per ${price.unit}`
}

/**
 * Render a 1e18-scaled multiplier with a plain-language reading of what it means.
 *
 * The wording deliberately does not claim a split ratio for an arbitrary
 * multiplier above 1.0. On live Robinhood Chain the non-1.0 multipliers belong to
 * income-accruing funds (SGOV at 1.000957..., WEEK at 2.006182...), where the
 * multiplier grew through distributions rather than a single split. Printing
 * "1.000957:1 split applied" for that would be actively misleading.
 *
 * @example
 * ```ts
 * import { formatMultiplier } from 'erc8056'
 *
 * formatMultiplier(10n ** 18n)        // '1x (no corporate actions applied)'
 * formatMultiplier(4n * 10n ** 18n)   // '4x (1 token represents 4 shares)'
 * formatMultiplier(10n ** 17n)        // '0.1x (1 token represents 0.1 shares)'
 * ```
 */
export function formatMultiplier(multiplier: bigint): string {
  const scale = toDecimalString(multiplier, 18)
  const wad = 1_000_000_000_000_000_000n

  if (multiplier === wad) return `${scale}x (no corporate actions applied)`
  return `${scale}x (1 token represents ${scale} shares)`
}
