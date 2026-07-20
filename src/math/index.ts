/**
 * The ERC-8056 math, in exact `bigint` arithmetic.
 *
 * Nothing in this module touches a float. Every function takes and returns
 * integers scaled by an explicit number of decimals. Float helpers exist, but
 * they live in `src/format.ts` and are named so you cannot reach for one by
 * accident: a `Number` cannot hold a 1e18-scaled balance without losing the low
 * bits, and losing the low bits of a position is not a display problem, it is a
 * reconciliation problem.
 */

import { InvalidDecimalsError, InvalidMultiplierError, NegativeAmountError, PriceUnitMismatchError } from '../errors.js'
import type { FixedPoint, Rounding, SharePrice, ShareAmount, TokenAmount, TokenPrice, UiMultiplier } from '../types.js'

/** The fixed-point scale of `uiMultiplier()`: `1e18` represents 1.0. */
export const WAD = 1_000_000_000_000_000_000n

/** Decimals of the multiplier scale (18). */
export const UI_MULTIPLIER_DECIMALS = 18

/**
 * The multiplier of a token with no corporate actions, and the value to assume
 * for a token that predates ERC-8056.
 */
export const DEFAULT_UI_MULTIPLIER = WAD as UiMultiplier

/**
 * Upper bound accepted by {@link uiMultiplier}, matching `MAX_UI_MULTIPLIER` in
 * the Solidity reference implementation.
 */
export const MAX_UI_MULTIPLIER = 10n ** 36n

/** Decimals of a Chainlink Robinhood Stock Token feed answer. */
export const CHAINLINK_FEED_DECIMALS = 8

/** Decimals of every canonical Robinhood Stock Token. */
export const STOCK_TOKEN_DECIMALS = 18

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Validate and tag a raw `uiMultiplier()` reading.
 *
 * @param value - The 1e18-scaled ratio read from the chain.
 * @returns The same value, typed as a {@link UiMultiplier}.
 * @throws {@link InvalidMultiplierError} when the value is zero, negative, or
 *   above {@link MAX_UI_MULTIPLIER}. Zero is rejected because it would zero out
 *   every share balance and make the inverse conversion a division by zero.
 *
 * @example
 * ```ts
 * import { uiMultiplier } from 'erc8056/math'
 *
 * const m = uiMultiplier(4_000_000_000_000_000_000n) // a 4:1 split
 * ```
 */
export function uiMultiplier(value: bigint): UiMultiplier {
  if (value <= 0n) {
    throw new InvalidMultiplierError(value, value === 0n ? 'a multiplier of zero would erase every share balance' : 'negative')
  }
  if (value > MAX_UI_MULTIPLIER) {
    throw new InvalidMultiplierError(value, `above MAX_UI_MULTIPLIER (${MAX_UI_MULTIPLIER})`)
  }
  return value as UiMultiplier
}

/**
 * Tag a raw ERC-20 balance as a {@link TokenAmount}.
 * @throws {@link NegativeAmountError} on a negative value.
 */
export function tokenAmount(value: bigint): TokenAmount {
  if (value < 0n) throw new NegativeAmountError(value, 'A token amount')
  return value as TokenAmount
}

/**
 * Tag a value as a {@link ShareAmount}.
 * @throws {@link NegativeAmountError} on a negative value.
 */
export function shareAmount(value: bigint): ShareAmount {
  if (value < 0n) throw new NegativeAmountError(value, 'A share amount')
  return value as ShareAmount
}

/**
 * Build a {@link TokenPrice}: the price of one whole TOKEN.
 *
 * Use this for a Chainlink Robinhood feed answer. See {@link tokenPriceFromFeed}
 * for the named version that documents why no adjustment is applied.
 */
export function tokenPrice(value: bigint, decimals: number): TokenPrice {
  assertDecimals(decimals)
  return { unit: 'token', value, decimals }
}

/** Build a {@link SharePrice}: the price of one underlying SHARE. */
export function sharePrice(value: bigint, decimals: number): SharePrice {
  assertDecimals(decimals)
  return { unit: 'share', value, decimals }
}

// ---------------------------------------------------------------------------
// Primitive fixed-point arithmetic
// ---------------------------------------------------------------------------

/**
 * Exact `a * b / denominator` with the requested rounding.
 *
 * `bigint` has no width limit, so unlike the Solidity original there is no
 * overflow to route around: the intermediate product is exact by construction.
 * The interesting part is rounding, which is explicit and never implicit.
 *
 * @param a - Left factor.
 * @param b - Right factor.
 * @param denominator - Divisor. Must be non-zero.
 * @param rounding - Direction, defaulting to `'down'` to match on-chain truncation.
 * @throws {RangeError} when `denominator` is zero.
 */
export function mulDiv(a: bigint, b: bigint, denominator: bigint, rounding: Rounding = 'down'): bigint {
  if (denominator === 0n) throw new RangeError('mulDiv: division by zero')

  const product = a * b
  const quotient = product / denominator
  const remainder = product % denominator

  if (remainder === 0n) return quotient

  const negative = product < 0n !== denominator < 0n

  switch (rounding) {
    case 'down':
      // BigInt division already truncates toward zero.
      return quotient
    case 'up':
      return negative ? quotient - 1n : quotient + 1n
    case 'nearest': {
      const twiceRemainder = abs(remainder) * 2n
      const absDenominator = abs(denominator)
      if (twiceRemainder < absDenominator) return quotient
      return negative ? quotient - 1n : quotient + 1n
    }
  }
}

/**
 * Move a fixed-point value between decimal scales exactly.
 *
 * This is the fix for the 6-vs-18 mismatch that shows up constantly on
 * Robinhood Chain: Stock Tokens are 18 decimals, USDG is 6, and Chainlink
 * answers are 8. Scaling by hand with `Number` division is where precision
 * quietly disappears.
 *
 * @param value - The scaled integer.
 * @param fromDecimals - Its current scale.
 * @param toDecimals - The scale to convert to.
 * @param rounding - Direction used when scaling down. Scaling up is always exact.
 *
 * @example
 * ```ts
 * import { rescale } from 'erc8056/math'
 *
 * // A Chainlink answer (8 dp) expressed at USDG's 6 dp, truncating.
 * rescale(31_550_000_000n, 8, 6) // 315_500_000n
 * ```
 */
export function rescale(value: bigint, fromDecimals: number, toDecimals: number, rounding: Rounding = 'down'): bigint {
  assertDecimals(fromDecimals)
  assertDecimals(toDecimals)
  if (fromDecimals === toDecimals) return value
  if (toDecimals > fromDecimals) return value * 10n ** BigInt(toDecimals - fromDecimals)
  return mulDiv(value, 1n, 10n ** BigInt(fromDecimals - toDecimals), rounding)
}

// ---------------------------------------------------------------------------
// Rule 2: share-equivalent quantities
// ---------------------------------------------------------------------------

/**
 * RULE 2. Convert a raw token balance into share-equivalent units:
 * `balance * uiMultiplier / 1e18`.
 *
 * This is the number a holder recognises as "how many shares do I own". The raw
 * `balanceOf` value is not that number the moment a corporate action lands, and
 * a portfolio UI that prints `balanceOf` as a share count is wrong for every
 * token that has ever split.
 *
 * Rounds down by default, exactly matching the on-chain `balanceOfUI(address)`.
 * Do not change that default for display: a UI that rounds up will disagree with
 * the chain, and the sum of rounded-up holder balances can exceed the total
 * share supply.
 *
 * @param balance - Raw ERC-20 balance in TOKEN units.
 * @param multiplier - The token's current 1e18-scaled multiplier.
 * @param rounding - Direction, defaulting to `'down'` for on-chain parity.
 * @returns The share-equivalent amount, at the same decimals as the token.
 *
 * @example
 * ```ts
 * import { shareEquivalent, tokenAmount, uiMultiplier } from 'erc8056/math'
 *
 * // 100 tokens after a 4:1 split are 400 shares. The balance never moved.
 * shareEquivalent(tokenAmount(100n * 10n ** 18n), uiMultiplier(4n * 10n ** 18n))
 * // 400000000000000000000n
 * ```
 */
export function shareEquivalent(
  balance: TokenAmount,
  multiplier: UiMultiplier,
  rounding: Rounding = 'down',
): ShareAmount {
  return mulDiv(balance, multiplier, WAD, rounding) as ShareAmount
}

/**
 * The inverse of {@link shareEquivalent}: how many TOKEN units carry a given
 * number of shares, i.e. `shares * 1e18 / uiMultiplier`.
 *
 * Rounds down by default to match the on-chain `sharesToTokens`. Pass `'up'`
 * when you are computing a transfer amount that must cover at least `shares`,
 * since a round trip through truncation can land one wei short.
 *
 * @param shares - The share-equivalent amount.
 * @param multiplier - The token's current 1e18-scaled multiplier.
 * @param rounding - Direction, defaulting to `'down'`.
 */
export function tokensForShares(
  shares: ShareAmount,
  multiplier: UiMultiplier,
  rounding: Rounding = 'down',
): TokenAmount {
  return mulDiv(shares, WAD, multiplier, rounding) as TokenAmount
}

// ---------------------------------------------------------------------------
// Rule 1: multiplier-adjusted pricing
// ---------------------------------------------------------------------------

/**
 * RULE 1, first half. Read a Chainlink Robinhood feed answer as what it actually
 * is: the price of one TOKEN.
 *
 * This function applies no adjustment, and that is the entire point of it
 * existing. Robinhood's Chainlink feeds are already multiplier-adjusted
 * upstream, so the answer is a total-return token price. Multiplying it by
 * `uiMultiplier` double-counts every corporate action the token has ever had.
 * Calling this instead of building the price inline makes the decision explicit
 * and reviewable.
 *
 * @param answer - The raw `latestRoundData().answer`.
 * @param answerDecimals - Feed decimals. Robinhood stock feeds use 8.
 *
 * @example
 * ```ts
 * import { tokenPriceFromFeed } from 'erc8056/math'
 *
 * const price = tokenPriceFromFeed(31_550_000_000n, 8)
 * // { unit: 'token', value: 31550000000n, decimals: 8 }  ->  $315.50 per token
 * ```
 */
export function tokenPriceFromFeed(answer: bigint, answerDecimals: number = CHAINLINK_FEED_DECIMALS): TokenPrice {
  return tokenPrice(answer, answerDecimals)
}

/**
 * RULE 1, second half. Derive the price of one underlying SHARE from a feed
 * answer: `answer * 1e18 / uiMultiplier`.
 *
 * DIVIDE, never multiply. After a 4:1 split the token still represents the same
 * economic value (its price does not move) while each underlying share is worth
 * a quarter as much. Dividing the token price by the multiplier recovers that.
 *
 * @param answer - The raw `latestRoundData().answer`.
 * @param answerDecimals - Feed decimals. Robinhood stock feeds use 8.
 * @param multiplier - The token's current 1e18-scaled multiplier.
 * @param rounding - Direction, defaulting to `'down'`.
 *
 * @example
 * ```ts
 * import { sharePriceFromFeed, uiMultiplier } from 'erc8056/math'
 *
 * // $315.50 per token, after a 4:1 split, is $78.875 per share.
 * sharePriceFromFeed(31_550_000_000n, 8, uiMultiplier(4n * 10n ** 18n))
 * // { unit: 'share', value: 7887500000n, decimals: 8 }
 * ```
 */
export function sharePriceFromFeed(
  answer: bigint,
  answerDecimals: number,
  multiplier: UiMultiplier,
  rounding: Rounding = 'down',
): SharePrice {
  assertDecimals(answerDecimals)
  return sharePrice(mulDiv(answer, WAD, multiplier, rounding), answerDecimals)
}

/**
 * Convert a {@link TokenPrice} into a {@link SharePrice}: divide by the multiplier.
 *
 * @throws {@link PriceUnitMismatchError} when handed a share price, which would
 *   otherwise silently apply the multiplier twice.
 */
export function toSharePrice(price: TokenPrice, multiplier: UiMultiplier, rounding: Rounding = 'down'): SharePrice {
  assertUnit(price, 'token', 'A share price is already multiplier-adjusted; converting it again divides twice.')
  return sharePrice(mulDiv(price.value, WAD, multiplier, rounding), price.decimals)
}

/**
 * Convert a {@link SharePrice} back into a {@link TokenPrice}: multiply by the
 * multiplier. The exact inverse of {@link toSharePrice}, and the only place in
 * this package where multiplying a price by the multiplier is correct.
 *
 * @throws {@link PriceUnitMismatchError} when handed a token price.
 */
export function toTokenPrice(price: SharePrice, multiplier: UiMultiplier, rounding: Rounding = 'down'): TokenPrice {
  assertUnit(price, 'share', 'A token price is what a Chainlink Robinhood feed already answers with.')
  return tokenPrice(mulDiv(price.value, multiplier, WAD, rounding), price.decimals)
}

/**
 * Value a position in the price's own decimals.
 *
 * `balance * tokenPrice`, with NO multiplier applied. This is the practical
 * consequence of rule 1 and the most common place to get it wrong: because the
 * feed answer is already multiplier-adjusted, the raw token balance is the
 * correct quantity to multiply it by. Using the share-equivalent balance here
 * would double-count the corporate action.
 *
 * Requires a {@link TokenPrice} at the type level, so the mistake does not compile.
 *
 * @param balance - Raw ERC-20 balance in TOKEN units.
 * @param price - The multiplier-adjusted price of one token.
 * @param tokenDecimals - Decimals of the token. Canonical Stock Tokens use 18.
 * @param rounding - Direction, defaulting to `'down'`.
 * @returns A {@link FixedPoint} value at `price.decimals`.
 *
 * @example
 * ```ts
 * import { positionValue, tokenAmount, tokenPriceFromFeed } from 'erc8056/math'
 *
 * // 2 tokens at $315.50 is $631.00, whatever the multiplier is.
 * positionValue(tokenAmount(2n * 10n ** 18n), tokenPriceFromFeed(31_550_000_000n, 8), 18)
 * // { value: 63100000000n, decimals: 8 }
 * ```
 */
export function positionValue(
  balance: TokenAmount,
  price: TokenPrice,
  tokenDecimals: number = STOCK_TOKEN_DECIMALS,
  rounding: Rounding = 'down',
): FixedPoint {
  assertUnit(
    price,
    'token',
    'Value a position with the token price and the raw balance. Pairing a share price with a raw balance misprices by the multiplier.',
  )
  assertDecimals(tokenDecimals)
  return { value: mulDiv(balance, price.value, 10n ** BigInt(tokenDecimals), rounding), decimals: price.decimals }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function abs(value: bigint): bigint {
  return value < 0n ? -value : value
}

function assertUnit<U extends 'token' | 'share'>(
  price: { unit: string },
  expected: U,
  hint: string,
): asserts price is { unit: U } & typeof price {
  if (price.unit !== expected) throw new PriceUnitMismatchError(expected, price.unit, hint)
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) throw new InvalidDecimalsError(decimals)
}
