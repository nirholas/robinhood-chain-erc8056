#!/usr/bin/env node
/**
 * Compile the Solidity reference implementation with the `solc` npm package and
 * write the artifacts to `artifacts/`.
 *
 * Foundry is the primary toolchain for these contracts (`npm run test:sol` runs
 * the real unit and fuzz suite). This script exists so that compilation is
 * verifiable with nothing but `npm install`: it is what `npm test` runs before
 * vitest, and `tests/abi.test.ts` asserts the hand-written TypeScript ABI
 * fragments match the real compiler output. That check is what keeps
 * `src/abi/index.ts` from drifting away from `contracts/`.
 *
 * Exits non-zero on any compiler error, so it can gate a release.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const solc = require('solc')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'artifacts')

const SOURCES = ['contracts/IERC8056.sol', 'contracts/ERC8056.sol', 'contracts/ERC8056StockToken.sol']

/**
 * Resolve an import to a file on disk. Handles the `@openzeppelin/contracts/`
 * remapping into node_modules and plain relative imports between our own files.
 */
function resolveImport(importPath) {
  if (importPath.startsWith('@openzeppelin/contracts/')) {
    return join(root, 'node_modules', importPath)
  }
  if (importPath.startsWith('./') || importPath.startsWith('../')) {
    return join(root, 'contracts', importPath)
  }
  return join(root, importPath)
}

const input = {
  language: 'Solidity',
  sources: Object.fromEntries(SOURCES.map((path) => [path, { content: readFileSync(join(root, path), 'utf8') }])),
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'cancun',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] } },
  },
}

function findImports(importPath) {
  try {
    return { contents: readFileSync(resolveImport(importPath), 'utf8') }
  } catch (error) {
    return { error: `Could not resolve import '${importPath}': ${error.message}` }
  }
}

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }))

const diagnostics = output.errors ?? []
const errors = diagnostics.filter((d) => d.severity === 'error')
const warnings = diagnostics.filter((d) => d.severity === 'warning')

for (const warning of warnings) {
  console.warn(`[warn] ${warning.formattedMessage.trim()}`)
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error.formattedMessage ?? error.message)
  }
  console.error(`\nFAIL: ${errors.length} compiler error(s).`)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })

const written = []
for (const [sourcePath, contracts] of Object.entries(output.contracts ?? {})) {
  for (const [name, artifact] of Object.entries(contracts)) {
    const file = join(outDir, `${name}.json`)
    writeFileSync(
      file,
      `${JSON.stringify(
        {
          contractName: name,
          sourceName: sourcePath,
          solcVersion: solc.version(),
          abi: artifact.abi,
          bytecode: `0x${artifact.evm?.bytecode?.object ?? ''}`,
          deployedBytecode: `0x${artifact.evm?.deployedBytecode?.object ?? ''}`,
        },
        null,
        2,
      )}\n`,
    )
    written.push({ name, bytes: (artifact.evm?.deployedBytecode?.object ?? '').length / 2 })
  }
}

console.log(`solc ${solc.version()}`)
for (const { name, bytes } of written.sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(`  ${name.padEnd(24)} ${bytes ? `${bytes} bytes deployed` : 'interface (no bytecode)'}`)
}
console.log(`\nPASS: ${written.length} artifact(s) written to artifacts/, ${warnings.length} warning(s), 0 errors.`)
