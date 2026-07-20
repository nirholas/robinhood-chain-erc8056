/**
 * Rule 1 against live data: token price vs share price.
 *
 * Run: `npm run example:pricing`
 *
 * Reads live Chainlink answers and live multipliers for the priced Stock Tokens,
 * then prints the token price (what the feed answers), the share price (feed
 * divided by the multiplier), and what a naive integration would have printed if
 * it multiplied instead. Today every multiplier is 1.0 so all three agree, which
 * is exactly why the bug is so easy to ship: it is invisible until the first
 * corporate action, and then it is wrong by the split ratio on every position.
 *
 * The final section runs the same math against a hypothetical 4:1 split so the
 * divergence is visible now rather than after it costs someone money.
 */
import { createPublicClient, http } from 'viem'
import { robinhood } from 'viem/chains'
import { listPricedStockTokens } from 'hoodchain'

import {
  formatPrice,
  positionValue,
  sharePriceFromFeed,
  toDecimalString,
  tokenAmount,
  tokenPriceFromFeed,
  toSharePrice,
  uiMultiplier,
  WAD,
} from '../src/index.js'
import { erc8056Abi } from '../src/abi/index.js'

const AGGREGATOR_V3_ABI = [
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
] as const

const client = createPublicClient({
  chain: robinhood,
  transport: http(process.env.ERC8056_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'),
})

const tokens = listPricedStockTokens().slice(0, 8)

console.log(`Chainlink answers and ERC-8056 multipliers on Robinhood Chain (chain ${robinhood.id})\n`)
console.log(`${'SYMBOL'.padEnd(8)}${'TOKEN PRICE'.padStart(16)}${'SHARE PRICE'.padStart(16)}  MULTIPLIER`)

for (const token of tokens) {
  const [round, multiplierRaw] = await Promise.all([
    client.readContract({ address: token.feed!, abi: AGGREGATOR_V3_ABI, functionName: 'latestRoundData' }),
    client.readContract({ address: token.address, abi: erc8056Abi, functionName: 'uiMultiplier' }),
  ])

  const [, answer] = round
  const multiplier = uiMultiplier(multiplierRaw)
  const feedDecimals = token.feedDecimals ?? 8

  // Rule 1: the answer IS the token price. No adjustment.
  const perToken = tokenPriceFromFeed(answer, feedDecimals)
  // Rule 1: DIVIDE by the multiplier for the underlying share price.
  const perShare = sharePriceFromFeed(answer, feedDecimals, multiplier)

  console.log(
    token.symbol.padEnd(8) +
      toDecimalString(perToken.value, perToken.decimals).padStart(16) +
      toDecimalString(perShare.value, perShare.decimals).padStart(16) +
      `  ${toDecimalString(multiplier, 18)}x`,
  )
}

// ---------------------------------------------------------------------------
// The divergence, made visible.
// ---------------------------------------------------------------------------

const sample = tokens[0]
if (!sample) {
  console.log('\nNo priced tokens in the registry.')
  process.exit(0)
}

const [, liveAnswer] = await client.readContract({
  address: sample.feed!,
  abi: AGGREGATOR_V3_ABI,
  functionName: 'latestRoundData',
})

const split = uiMultiplier(4n * WAD)
const perToken = tokenPriceFromFeed(liveAnswer, sample.feedDecimals ?? 8)
const perShare = toSharePrice(perToken, split)
const balance = tokenAmount(10n * WAD) // 10 tokens

console.log(`\nIf ${sample.symbol} ran a 4:1 split tomorrow, at today's live feed answer:`)
console.log(`  feed answer stays          ${formatPrice(perToken)}`)
console.log(`  underlying share becomes   ${formatPrice(perShare)}`)
console.log(`  a 10-token position is     ${toDecimalString(positionValue(balance, perToken, 18).value, perToken.decimals)} USD`)
console.log(`  ...and represents          ${toDecimalString((balance * split) / WAD, 18)} shares`)
console.log(
  `\nThe position value does NOT change across the split, because the feed price is already\n` +
    `multiplier-adjusted. An integration that multiplied the feed answer by the multiplier would\n` +
    `have reported 4x the true value the day the split landed.`,
)
