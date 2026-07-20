/**
 * Keeps `src/abi/index.ts` honest.
 *
 * Every fragment the TypeScript package exports is checked against the artifact
 * produced by really compiling `contracts/` with solc (`npm run build:contracts`,
 * which `npm test` runs first). If someone edits a Solidity signature without
 * updating the ABI fragment, or the reverse, this fails.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { toFunctionSelector, toFunctionSignature, type AbiFunction } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  BALANCE_OF_UI_SELECTOR,
  erc8056Abi,
  erc8056ScheduledAbi,
  stockTokenReadAbi,
  TOTAL_SUPPLY_UI_SELECTOR,
  UI_MULTIPLIER_SELECTOR,
} from '../src/abi/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function artifact(name: string): { abi: readonly unknown[]; deployedBytecode: string } {
  const path = join(root, 'artifacts', `${name}.json`)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(
      `Missing artifact ${path}. Run \`npm run build:contracts\` (npm test does this automatically) to compile contracts/ with solc.`,
    )
  }
}

/** Every function signature present on a compiled contract's ABI. */
function signatures(abi: readonly unknown[]): Set<string> {
  return new Set(
    abi.filter((entry): entry is AbiFunction => (entry as { type?: string }).type === 'function').map(toFunctionSignature),
  )
}

function eventNames(abi: readonly unknown[]): Set<string> {
  return new Set(
    abi
      .filter((entry): entry is { type: 'event'; name: string } => (entry as { type?: string }).type === 'event')
      .map((entry) => entry.name),
  )
}

describe('compiled artifacts', () => {
  it('produces deployable bytecode for the concrete stock token', () => {
    const compiled = artifact('ERC8056StockToken')
    expect(compiled.deployedBytecode.startsWith('0x')).toBe(true)
    expect(compiled.deployedBytecode.length).toBeGreaterThan(2)
    // EIP-170 caps deployed bytecode at 24576 bytes.
    expect((compiled.deployedBytecode.length - 2) / 2).toBeLessThan(24_576)
  })

  it('compiles IERC8056 as a pure interface', () => {
    const compiled = artifact('IERC8056')
    expect(signatures(compiled.abi)).toEqual(
      new Set(['uiMultiplier()', 'balanceOfUI(address)', 'totalSupplyUI()']),
    )
    expect(eventNames(compiled.abi)).toEqual(new Set(['UIMultiplierUpdated']))
  })

  it('compiles IERC8056Scheduled with exactly the pending-action surface', () => {
    expect(signatures(artifact('IERC8056Scheduled').abi)).toEqual(new Set(['newUIMultiplier()', 'effectiveAt()']))
  })
})

describe('erc8056Abi matches the compiled interface', () => {
  it('declares every function IERC8056 declares, and no more', () => {
    expect(signatures(erc8056Abi)).toEqual(signatures(artifact('IERC8056').abi))
  })

  it('declares the UIMultiplierUpdated event with the compiled input types', () => {
    const compiled = artifact('IERC8056').abi.find(
      (entry) => (entry as { name?: string }).name === 'UIMultiplierUpdated',
    ) as { inputs: { name: string; type: string; indexed: boolean }[] }

    const ours = erc8056Abi.find((entry) => entry.name === 'UIMultiplierUpdated') as unknown as {
      inputs: { name: string; type: string; indexed: boolean }[]
    }

    expect(ours.inputs.map((i) => [i.name, i.type, i.indexed])).toEqual(
      compiled.inputs.map((i) => [i.name, i.type, i.indexed]),
    )
  })
})

describe('erc8056ScheduledAbi matches the compiled interface', () => {
  it('declares every function IERC8056Scheduled declares, and no more', () => {
    expect(signatures(erc8056ScheduledAbi)).toEqual(signatures(artifact('IERC8056Scheduled').abi))
  })
})

describe('stockTokenReadAbi is a subset of the deployed token', () => {
  it('every function it declares exists on ERC8056StockToken', () => {
    const deployed = signatures(artifact('ERC8056StockToken').abi)
    for (const signature of signatures(stockTokenReadAbi)) {
      expect(deployed, `${signature} is missing from the compiled token`).toContain(signature)
    }
  })
})

describe('exported selectors', () => {
  it('match the real keccak selectors of the compiled functions', () => {
    expect(UI_MULTIPLIER_SELECTOR).toBe(toFunctionSelector('uiMultiplier()'))
    expect(BALANCE_OF_UI_SELECTOR).toBe(toFunctionSelector('balanceOfUI(address)'))
    expect(TOTAL_SUPPLY_UI_SELECTOR).toBe(toFunctionSelector('totalSupplyUI()'))
  })

  it('match the selector observed on mainnet AAPL, verified by scripts/verify-onchain.mjs', () => {
    // The README records a live read of this exact selector returning 1e18.
    expect(UI_MULTIPLIER_SELECTOR).toBe('0xa60bf13d')
  })
})
