/**
 * erc8056: the reference implementation and canonical explainer for ERC-8056
 * (`uiMultiplier()`), the corporate-actions standard behind Robinhood's Stock
 * Tokens.
 *
 * Two rules govern every integration. Both are enforced by the types in this
 * package, not merely documented:
 *
 * 1. A Chainlink Robinhood feed answer is ALREADY multiplier-adjusted. It is the
 *    price of one TOKEN, not one share. To get the share price, DIVIDE by the
 *    multiplier. Never multiply. See {@link sharePriceFromFeed}, and note that
 *    {@link positionValue} demands a {@link TokenPrice} at the type level so the
 *    mistake does not compile.
 *
 * 2. Share-equivalent quantities are `balance * uiMultiplier / 1e18`. The raw
 *    `balanceOf` value is a TOKEN quantity and stops being a share count the
 *    moment a corporate action lands. See {@link shareEquivalent}, and note that
 *    {@link TokenAmount} and {@link ShareAmount} are distinct types.
 *
 * The Solidity reference implementation lives in `contracts/` and ships with the
 * package.
 */

export {
  BALANCE_OF_UI_SELECTOR,
  erc20ReadAbi,
  erc8056Abi,
  erc8056ScheduledAbi,
  stockTokenReadAbi,
  TOTAL_SUPPLY_UI_SELECTOR,
  UI_MULTIPLIER_SELECTOR,
} from './abi/index.js'

export {
  Erc8056Error,
  InvalidDecimalsError,
  InvalidMultiplierError,
  NegativeAmountError,
  PriceUnitMismatchError,
} from './errors.js'

export { formatFixedPoint, formatMultiplier, formatPrice, toDecimalString, toFloat } from './format.js'

export {
  CHAINLINK_FEED_DECIMALS,
  DEFAULT_UI_MULTIPLIER,
  MAX_UI_MULTIPLIER,
  mulDiv,
  positionValue,
  rescale,
  shareAmount,
  shareEquivalent,
  sharePrice,
  sharePriceFromFeed,
  STOCK_TOKEN_DECIMALS,
  toSharePrice,
  tokenAmount,
  tokenPrice,
  tokenPriceFromFeed,
  tokensForShares,
  toTokenPrice,
  UI_MULTIPLIER_DECIMALS,
  uiMultiplier,
  WAD,
} from './math/index.js'

export {
  isMissingFunctionError,
  readMultiplierState,
  readScheduledAction,
  readShareEquivalent,
  readUiMultiplier,
  type Erc8056Reader,
  type ReadMultiplierOptions,
} from './read.js'

export type {
  Branded,
  FixedPoint,
  MultiplierState,
  Price,
  PriceUnit,
  Rounding,
  ScheduledAction,
  ShareAmount,
  SharePrice,
  TokenAmount,
  TokenPrice,
  UiMultiplier,
} from './types.js'
