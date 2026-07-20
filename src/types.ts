/**
 * The unit system. This file exists to make the two ERC-8056 rules
 * unrepresentable-if-wrong rather than merely documented.
 *
 * A token that implements ERC-8056 has two distinct quantity units and two
 * distinct price units, and every integration bug in this space comes from
 * silently swapping one for the other. TypeScript can catch that at compile
 * time, so it does.
 */

declare const unitBrand: unique symbol

/** A nominal-typed `bigint`. Zero runtime cost: it is a plain bigint at runtime. */
export type Branded<B extends string> = bigint & { readonly [unitBrand]: B }

/**
 * A raw ERC-20 balance, in TOKEN units. This is what `balanceOf` returns, what
 * `transfer` moves, and what an AMM pool holds. It does NOT change when a
 * corporate action happens.
 */
export type TokenAmount = Branded<'TokenAmount'>

/**
 * A share-equivalent quantity: what the holder economically owns, and what a
 * brokerage statement would print. Derived from a {@link TokenAmount} via the
 * multiplier. Never transferable directly.
 */
export type ShareAmount = Branded<'ShareAmount'>

/**
 * A 1e18-scaled shares-per-token ratio, as returned by `uiMultiplier()`.
 * Guaranteed non-zero by {@link uiMultiplier}.
 */
export type UiMultiplier = Branded<'UiMultiplier'>

/**
 * A price, tagged with the unit it prices.
 *
 * The tag is a runtime-inspectable discriminant, not just a compile-time brand,
 * because getting this backwards is the single most expensive mistake an
 * integrator can make: it silently misprices every position by the multiplier
 * instead of failing loudly.
 *
 * @typeParam U - `'token'` for the price of one whole token, `'share'` for the
 *   price of one underlying share.
 */
export interface Price<U extends PriceUnit> {
  /** Which unit this price is quoted in. */
  readonly unit: U
  /** Fixed-point price value at {@link Price.decimals} decimals. */
  readonly value: bigint
  /** Number of decimals `value` is scaled by. Chainlink stock feeds use 8. */
  readonly decimals: number
}

/** The two things a price can be quoted per. */
export type PriceUnit = 'token' | 'share'

/**
 * The price of ONE TOKEN.
 *
 * This is what a Chainlink Robinhood Stock Token feed answers with. The feed is
 * already multiplier-adjusted upstream, so this price is total-return: after a
 * 4:1 split the share price quarters but the token price does not move.
 * Multiplying it by `uiMultiplier` double-counts the corporate action.
 */
export type TokenPrice = Price<'token'>

/**
 * The price of ONE UNDERLYING SHARE.
 *
 * This is what a stock ticker on a financial site shows. Derived from a
 * {@link TokenPrice} by DIVIDING by the multiplier.
 */
export type SharePrice = Price<'share'>

/** A fixed-point value carrying its own scale, used for computed USD amounts. */
export interface FixedPoint {
  /** The scaled integer value. */
  readonly value: bigint
  /** Number of decimals `value` is scaled by. */
  readonly decimals: number
}

/**
 * Rounding direction for a fixed-point division.
 *
 * `'down'` (truncate toward zero) is the default everywhere in this package
 * because it is what the on-chain reference implementation does, and matching
 * on-chain exactly matters more than matching a mathematical ideal: a UI that
 * rounds differently from `balanceOfUI()` will show numbers that disagree with
 * the chain.
 */
export type Rounding = 'down' | 'up' | 'nearest'

/**
 * The state of a token's ERC-8056 surface, including whether it has one at all.
 */
export interface MultiplierState {
  /**
   * The effective multiplier. Equals `1e18` when {@link MultiplierState.implemented}
   * is `false`, which is the correct reading for a token that predates the standard.
   */
  readonly multiplier: UiMultiplier
  /**
   * `false` when the token has no `uiMultiplier()` function, i.e. the call
   * reverted or returned no data. A pre-ERC-8056 token's balances already are
   * share equivalents, so a 1:1 multiplier is the right interpretation.
   */
  readonly implemented: boolean
}

/** A pending corporate action read from a token's ERC-8056 scheduled surface. */
export interface ScheduledAction {
  /** The 1e18-scaled multiplier that takes effect at {@link ScheduledAction.effectiveAt}. */
  readonly newMultiplier: UiMultiplier
  /** Unix timestamp (seconds) at which it becomes effective. */
  readonly effectiveAt: number
}
