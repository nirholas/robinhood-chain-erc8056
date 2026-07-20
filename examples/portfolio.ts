/**
 * Share-equivalent portfolio math against live Robinhood Chain mainnet.
 *
 * Run: `npm run example:portfolio -- 0xYourAddress`
 *
 * Reads every canonical Stock Token balance for an address and prints both
 * numbers a holder cares about: the raw TOKEN balance (what `transfer` moves)
 * and the SHARE-EQUIVALENT balance (what a brokerage statement would show).
 * Today every multiplier on chain is exactly 1.0, so the two columns match. The
 * moment an issuer runs a split they diverge, and a tracker that only ever
 * printed the first column starts lying.
 */
import { createPublicClient, http, type Address } from 'viem'
import { robinhood } from 'viem/chains'
import { listStockTokens } from 'hoodchain'

import { formatMultiplier, shareEquivalent, toDecimalString, tokenAmount, uiMultiplier } from '../src/index.js'
import { erc8056Abi } from '../src/abi/index.js'

const owner = (process.argv[2] ?? '') as Address
if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) {
  console.error('Usage: npm run example:portfolio -- 0xYourAddress')
  process.exit(1)
}

const client = createPublicClient({
  chain: robinhood,
  transport: http(process.env.ERC8056_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'),
})

const tokens = listStockTokens()

// One multicall for balances, one for multipliers. Multicall3 is deployed at the
// canonical address on chain 4663, so viem batches these automatically.
const reads = await client.multicall({
  contracts: tokens.flatMap((token) => [
    {
      address: token.address,
      abi: [
        {
          type: 'function',
          name: 'balanceOf',
          stateMutability: 'view',
          inputs: [{ name: 'account', type: 'address' }],
          outputs: [{ type: 'uint256' }],
        },
      ] as const,
      functionName: 'balanceOf' as const,
      args: [owner] as const,
    },
    { address: token.address, abi: erc8056Abi, functionName: 'uiMultiplier' as const },
  ]),
  allowFailure: false,
})

const held = tokens
  .map((token, index) => ({
    token,
    balance: tokenAmount(reads[index * 2] as bigint),
    multiplier: uiMultiplier(reads[index * 2 + 1] as bigint),
  }))
  .filter((position) => position.balance > 0n)

console.log(`Portfolio for ${owner} on Robinhood Chain (chain ${robinhood.id})`)

if (held.length === 0) {
  console.log(`\nNo Stock Token balances found across ${tokens.length} canonical tokens.`)
  console.log('Pass an address that holds Stock Tokens to see the share-equivalent columns.')
  process.exit(0)
}

console.log(`\n${'SYMBOL'.padEnd(8)}${'TOKEN BALANCE'.padStart(24)}${'SHARE EQUIVALENT'.padStart(24)}  MULTIPLIER`)

for (const { token, balance, multiplier } of held) {
  const shares = shareEquivalent(balance, multiplier)
  console.log(
    token.symbol.padEnd(8) +
      toDecimalString(balance, token.decimals).padStart(24) +
      toDecimalString(shares, token.decimals).padStart(24) +
      `  ${formatMultiplier(multiplier)}`,
  )
}

const divergent = held.filter(({ balance, multiplier }) => shareEquivalent(balance, multiplier) !== (balance as bigint))
console.log(
  `\n${held.length} position(s). ${divergent.length} where the share equivalent differs from the raw balance` +
    `${divergent.length === 0 ? ' (every multiplier is still 1.0, so no corporate action has landed yet).' : '.'}`,
)
