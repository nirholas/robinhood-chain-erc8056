/** Base class for every error this package throws. */
export class Erc8056Error extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** Thrown when a value that must be a valid 1e18-scaled multiplier is not. */
export class InvalidMultiplierError extends Erc8056Error {
  /** The rejected value. */
  readonly multiplier: bigint

  constructor(multiplier: bigint, reason: string) {
    super(
      `Invalid uiMultiplier ${multiplier}: ${reason}. A multiplier is a 1e18-scaled ` +
        `shares-per-token ratio, so 1e18 means 1 token = 1 share.`,
    )
    this.multiplier = multiplier
  }
}

/** Thrown when a quantity that must be non-negative is negative. */
export class NegativeAmountError extends Erc8056Error {
  /** The rejected value. */
  readonly amount: bigint

  constructor(amount: bigint, what: string) {
    super(`${what} must be non-negative, got ${amount}.`)
    this.amount = amount
  }
}

/**
 * Thrown when a price tagged with one unit is used where the other is required.
 *
 * This is the guard behind rule 1. Passing a share price where a token price is
 * expected (or the reverse) is off by exactly the multiplier, which is invisible
 * in the numbers and catastrophic in the output.
 */
export class PriceUnitMismatchError extends Erc8056Error {
  /** The unit that was required. */
  readonly expected: string
  /** The unit that was supplied. */
  readonly received: string

  constructor(expected: string, received: string, hint: string) {
    super(`Expected a '${expected}' price but received a '${received}' price. ${hint}`)
    this.expected = expected
    this.received = received
  }
}

/** Thrown when a decimals argument is not a usable non-negative integer. */
export class InvalidDecimalsError extends Erc8056Error {
  /** The rejected value. */
  readonly decimals: number

  constructor(decimals: number) {
    super(`Decimals must be a non-negative integer no greater than 77, got ${decimals}.`)
    this.decimals = decimals
  }
}
