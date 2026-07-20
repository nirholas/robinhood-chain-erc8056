/**
 * Reading a token's ERC-8056 surface over RPC.
 *
 * The whole difficulty here is one sentence from the spec: a token that predates
 * ERC-8056 has no `uiMultiplier()`, and a caller must treat that as 1e18 rather
 * than throwing. Implementing that naively (wrap the call in try/catch, return
 * 1e18 on any error) turns every RPC outage into a silent, plausible-looking
 * wrong answer. This module separates the two cases explicitly.
 */

import {
  AbiDecodingZeroDataError,
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  RawContractError,
  type Address,
  type PublicClient,
} from 'viem'

import { erc8056Abi, erc8056ScheduledAbi } from './abi/index.js'
import { DEFAULT_UI_MULTIPLIER, shareEquivalent, tokenAmount, uiMultiplier } from './math/index.js'
import type { MultiplierState, ScheduledAction, ShareAmount, UiMultiplier } from './types.js'

/** The subset of a viem `PublicClient` this module needs. */
export type Erc8056Reader = Pick<PublicClient, 'readContract'>

/**
 * Is this error the chain telling us the function does not exist, as opposed to
 * the network telling us it could not ask?
 *
 * The distinction is the entire safety property of {@link readUiMultiplier}. A
 * missing function surfaces as a revert with empty returndata, a `0x` response
 * that cannot be ABI-decoded, or an explicit revert. A timeout, a 503, a rate
 * limit, or a DNS failure surfaces as a transport error and MUST propagate:
 * answering "the multiplier is 1.0" because the RPC was briefly unreachable
 * would misreport every position on a token that has split.
 *
 * @param error - The thrown value.
 * @returns `true` only when the chain executed the call and it produced no result.
 */
export function isMissingFunctionError(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false

  const matched = error.walk(
    (e) =>
      e instanceof ContractFunctionZeroDataError ||
      e instanceof AbiDecodingZeroDataError ||
      e instanceof ContractFunctionRevertedError ||
      e instanceof RawContractError,
  )

  return matched !== null && matched !== undefined
}

/** Options accepted by {@link readUiMultiplier} and {@link readMultiplierState}. */
export interface ReadMultiplierOptions {
  /**
   * Read at a specific block instead of the latest one. Useful for reconciling a
   * historical statement, where the multiplier in force at the time is what
   * matters rather than today's.
   */
  blockNumber?: bigint
}

/**
 * Read `uiMultiplier()`, resolving a token that does not implement ERC-8056 to
 * `1e18` instead of throwing.
 *
 * A pre-ERC-8056 token's balances already are share equivalents, so 1:1 is the
 * correct interpretation and every downstream calculation stays valid. Transport
 * failures are NOT absorbed: they propagate, because a wrong multiplier is worse
 * than a visible error.
 *
 * @param client - Any viem `PublicClient` for the chain the token lives on.
 * @param token - The token contract address.
 * @param options - Optional block pinning.
 * @returns The validated multiplier.
 * @throws The underlying viem error on any transport or RPC failure.
 * @throws {@link InvalidMultiplierError} when a token reports zero or an
 *   out-of-range multiplier, which is a broken token rather than a missing one.
 *
 * @example
 * ```ts
 * import { createPublicClient, http } from 'viem'
 * import { robinhood } from 'viem/chains'
 * import { readUiMultiplier } from 'erc8056'
 *
 * const client = createPublicClient({ chain: robinhood, transport: http() })
 * const multiplier = await readUiMultiplier(client, '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9')
 * // 1000000000000000000n
 * ```
 */
export async function readUiMultiplier(
  client: Erc8056Reader,
  token: Address,
  options: ReadMultiplierOptions = {},
): Promise<UiMultiplier> {
  return (await readMultiplierState(client, token, options)).multiplier
}

/**
 * Like {@link readUiMultiplier}, but also reports whether the token implements
 * the standard at all.
 *
 * Use this when the answer matters to the caller, for example to label a token
 * as pre-8056 in a UI rather than implying it has a real 1:1 multiplier.
 */
export async function readMultiplierState(
  client: Erc8056Reader,
  token: Address,
  options: ReadMultiplierOptions = {},
): Promise<MultiplierState> {
  try {
    const raw = await client.readContract({
      address: token,
      abi: erc8056Abi,
      functionName: 'uiMultiplier',
      ...(options.blockNumber === undefined ? {} : { blockNumber: options.blockNumber }),
    })
    return { multiplier: uiMultiplier(raw), implemented: true }
  } catch (error) {
    if (isMissingFunctionError(error)) {
      return { multiplier: DEFAULT_UI_MULTIPLIER, implemented: false }
    }
    throw error
  }
}

/**
 * Read the pending corporate action, if the token exposes the scheduled
 * extension and something is actually scheduled.
 *
 * @returns The pending action, or `null` when nothing is scheduled or the token
 *   does not implement the extension.
 */
export async function readScheduledAction(
  client: Erc8056Reader,
  token: Address,
  options: ReadMultiplierOptions = {},
): Promise<ScheduledAction | null> {
  const block = options.blockNumber === undefined ? {} : { blockNumber: options.blockNumber }

  try {
    const [newMultiplier, effectiveAt] = await Promise.all([
      client.readContract({ address: token, abi: erc8056ScheduledAbi, functionName: 'newUIMultiplier', ...block }),
      client.readContract({ address: token, abi: erc8056ScheduledAbi, functionName: 'effectiveAt', ...block }),
    ])

    if (effectiveAt === 0n) return null
    return { newMultiplier: uiMultiplier(newMultiplier), effectiveAt: Number(effectiveAt) }
  } catch (error) {
    if (isMissingFunctionError(error)) return null
    throw error
  }
}

/**
 * Read a holder's share-equivalent balance.
 *
 * Prefers the token's own `balanceOfUI(address)` so the number matches the chain
 * byte for byte. Falls back to `balanceOf` combined with
 * {@link shareEquivalent} when the token does not expose that view, which
 * produces the identical result because both compute
 * `balance * multiplier / 1e18` with truncation.
 *
 * @param client - Any viem `PublicClient`.
 * @param token - The token contract address.
 * @param owner - The holder to query.
 * @returns The share-equivalent balance, at the token's own decimals.
 */
export async function readShareEquivalent(
  client: Erc8056Reader,
  token: Address,
  owner: Address,
  options: ReadMultiplierOptions = {},
): Promise<ShareAmount> {
  const block = options.blockNumber === undefined ? {} : { blockNumber: options.blockNumber }

  try {
    const shares = await client.readContract({
      address: token,
      abi: erc8056Abi,
      functionName: 'balanceOfUI',
      args: [owner],
      ...block,
    })
    return shares as ShareAmount
  } catch (error) {
    if (!isMissingFunctionError(error)) throw error
  }

  const [balance, state] = await Promise.all([
    client.readContract({
      address: token,
      abi: [
        {
          type: 'function',
          name: 'balanceOf',
          stateMutability: 'view',
          inputs: [{ name: 'account', type: 'address' }],
          outputs: [{ type: 'uint256' }],
        },
      ] as const,
      functionName: 'balanceOf',
      args: [owner],
      ...block,
    }),
    readMultiplierState(client, token, options),
  ])

  return shareEquivalent(tokenAmount(balance), state.multiplier)
}
