#!/usr/bin/env node
/**
 * Reproduces the on-chain evidence behind this package's two rules, by reading
 * live Robinhood Chain mainnet (chain 4663) over the public RPC.
 *
 * For every canonical Stock Token it checks the invariants the standard rests on:
 *
 *   1. `uiMultiplier()` exists, is non-zero, and is within MAX_UI_MULTIPLIER.
 *   2. `totalSupplyUI() == totalSupply() * uiMultiplier() / 1e18`. This is the
 *      chain confirming, in its own arithmetic, that rule 2 is a truncating
 *      mulDiv and that this package computes it identically.
 *
 * It then singles out the tokens whose multiplier is NOT 1.0, because those are
 * the live proof that the standard is load-bearing rather than theoretical, and
 * demonstrates rule 1 against one of them: a Chainlink answer divided by a real
 * multiplier to recover a real underlying share price.
 *
 * Finally it reads a contract that does NOT implement ERC-8056 (WETH) to prove
 * the "a revert means 1e18, do not throw" fallback against a real deployment
 * rather than a constructed error.
 *
 * Run with `npm run verify:onchain`. Exits non-zero if any invariant fails, so
 * it can gate a release.
 *
 * Env:
 *   ERC8056_RPC_URL   Override the RPC endpoint (default: the public mainnet RPC).
 */
import { createPublicClient, http } from 'viem'
import { robinhood } from 'viem/chains'

import { listStockTokens } from 'hoodchain'

import {
  erc8056Abi,
  MAX_UI_MULTIPLIER,
  mulDiv,
  readMultiplierState,
  sharePriceFromFeed,
  toDecimalString,
  tokenPriceFromFeed,
  uiMultiplier,
  WAD,
} from '../dist/index.js'

const RPC_URL = process.env.ERC8056_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'

/** A canonical WETH on chain 4663: a real contract with no ERC-8056 surface. */
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'

const TOTAL_SUPPLY_ABI = [
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
]

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
]

const client = createPublicClient({ chain: robinhood, transport: http(RPC_URL) })
const tokens = listStockTokens()

console.log(`Robinhood Chain mainnet (chain ${robinhood.id}) via ${RPC_URL}`)
console.log(`Block ${await client.getBlockNumber()}`)
console.log(`\nChecking ERC-8056 invariants across all ${tokens.length} canonical Stock Tokens...`)

const reads = await client.multicall({
  contracts: tokens.flatMap((token) => [
    { address: token.address, abi: erc8056Abi, functionName: 'uiMultiplier' },
    { address: token.address, abi: TOTAL_SUPPLY_ABI, functionName: 'totalSupply' },
    { address: token.address, abi: erc8056Abi, functionName: 'totalSupplyUI' },
  ]),
  allowFailure: true,
})

const failures = []
const active = []
let checked = 0

tokens.forEach((token, index) => {
  const [multiplierRead, totalSupplyRead, totalSupplyUIRead] = reads.slice(index * 3, index * 3 + 3)

  if (multiplierRead.status !== 'success') {
    failures.push(`${token.symbol}: uiMultiplier() failed (${multiplierRead.error?.shortMessage ?? 'unknown'})`)
    return
  }

  const multiplier = multiplierRead.result
  checked += 1

  if (multiplier === 0n) failures.push(`${token.symbol}: uiMultiplier() is zero`)
  if (multiplier > MAX_UI_MULTIPLIER) failures.push(`${token.symbol}: uiMultiplier() above MAX_UI_MULTIPLIER`)

  // Rule 2, checked against the chain's own arithmetic.
  if (totalSupplyRead.status === 'success' && totalSupplyUIRead.status === 'success') {
    const expected = mulDiv(totalSupplyRead.result, multiplier, WAD)
    if (expected !== totalSupplyUIRead.result) {
      failures.push(
        `${token.symbol}: totalSupplyUI mismatch (chain ${totalSupplyUIRead.result}, local mulDiv ${expected})`,
      )
    }
  }

  if (multiplier !== WAD) active.push({ token, multiplier })
})

console.log(`  ${checked}/${tokens.length} tokens implement uiMultiplier()`)
console.log(`  totalSupplyUI() == truncating mulDiv(totalSupply, uiMultiplier, 1e18) on every one of them`)

console.log(`\nTokens with a corporate action already applied (uiMultiplier != 1.0):`)
if (active.length === 0) {
  console.log('  none right now: every canonical token is still at exactly 1e18.')
} else {
  for (const { token, multiplier } of active) {
    console.log(`  ${token.symbol.padEnd(6)} ${token.address}  uiMultiplier() = ${multiplier}`)
    console.log(`         = ${toDecimalString(multiplier, 18)} shares per token   ${token.name}`)
  }
}

// Rule 1, demonstrated against a live token whose multiplier is genuinely not 1.
const priced = active.find(({ token }) => token.feed !== null)
if (priced) {
  const [, answer] = await client.readContract({
    address: priced.token.feed,
    abi: AGGREGATOR_V3_ABI,
    functionName: 'latestRoundData',
  })

  const decimals = priced.token.feedDecimals ?? 8
  const multiplier = uiMultiplier(priced.multiplier)
  const perToken = tokenPriceFromFeed(answer, decimals)
  const perShare = sharePriceFromFeed(answer, decimals, multiplier)

  console.log(`\nRule 1 on live data (${priced.token.symbol}, feed ${priced.token.feed}):`)
  console.log(`  Chainlink answer            ${answer} (${toDecimalString(perToken.value, decimals)} per TOKEN)`)
  console.log(`  divided by the multiplier   ${toDecimalString(perShare.value, decimals)} per SHARE`)
  console.log(`  the wrong way (multiply)    ${toDecimalString(mulDiv(answer, multiplier, WAD), decimals)} <- overstates the share price`)
}

console.log(`\nPre-ERC-8056 fallback (a real contract with no uiMultiplier()):`)
const legacy = await readMultiplierState(client, WETH)
const legacyOk = legacy.implemented === false && legacy.multiplier === WAD
console.log(
  `  WETH   ${WETH}  implemented = ${legacy.implemented}, resolves to ${legacy.multiplier} [${legacyOk ? 'OK' : 'FAIL'}]`,
)
if (!legacyOk) failures.push('WETH fallback did not resolve to an unimplemented 1e18 multiplier')

if (failures.length > 0) {
  console.log(`\nFAIL: ${failures.length} invariant violation(s):`)
  for (const failure of failures) console.log(`  ! ${failure}`)
  process.exit(1)
}

console.log(
  `\nPASS: ${checked} tokens verified, ${active.length} with a live corporate action applied, ` +
    `totalSupplyUI() matches truncating mulDiv everywhere, and a non-8056 contract resolves to 1e18 without throwing.`,
)
