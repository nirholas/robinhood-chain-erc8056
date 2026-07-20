/**
 * ERC-8056 ABI fragments.
 *
 * `erc8056Abi` is the minimal fragment: exactly the members of `IERC8056`, and
 * nothing else. It is deliberately small so it can be spread into whatever ABI
 * an integration already has without dragging in an opinion about the rest of
 * the token.
 *
 * These fragments are checked against the compiled Solidity in
 * `tests/abi.test.ts`, which loads the artifact `npm run build:contracts`
 * produces and asserts that every entry here exists on the real contract with
 * the same signature. The TypeScript and the Solidity cannot drift apart
 * without a test failing.
 */

/** The `uiMultiplier()` selector, `bytes4(keccak256("uiMultiplier()"))`. */
export const UI_MULTIPLIER_SELECTOR = '0xa60bf13d' as const

/** The `balanceOfUI(address)` selector. */
export const BALANCE_OF_UI_SELECTOR = '0x437a9958' as const

/** The `totalSupplyUI()` selector. */
export const TOTAL_SUPPLY_UI_SELECTOR = '0x9bea6429' as const

/** The core ERC-8056 interface: `uiMultiplier`, `balanceOfUI`, `totalSupplyUI`, and the update event. */
export const erc8056Abi = [
  {
    type: 'function',
    name: 'uiMultiplier',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'multiplier', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOfUI',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalSupplyUI',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'UIMultiplierUpdated',
    inputs: [
      { name: 'oldMultiplier', type: 'uint256', indexed: false },
      { name: 'newMultiplier', type: 'uint256', indexed: false },
      { name: 'effectiveAt', type: 'uint256', indexed: false },
    ],
  },
] as const

/**
 * The optional scheduled-action extension: the pending multiplier and its
 * effective time. Canonical Robinhood Stock Tokens implement this alongside the
 * core interface.
 */
export const erc8056ScheduledAbi = [
  {
    type: 'function',
    name: 'newUIMultiplier',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'multiplier', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'effectiveAt',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'timestamp', type: 'uint256' }],
  },
] as const

/** The ERC-20 members this package reads. Not a full ERC-20 ABI. */
export const erc20ReadAbi = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const

/**
 * Everything a Stock Token exposes that this package knows how to read: the
 * ERC-20 read surface plus both ERC-8056 interfaces.
 */
export const stockTokenReadAbi = [...erc20ReadAbi, ...erc8056Abi, ...erc8056ScheduledAbi] as const
