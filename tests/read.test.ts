/**
 * The fallback contract, exercised against real viem error objects.
 *
 * These tests drive a real `createPublicClient` through a custom transport, so
 * the errors under test are the genuine viem error classes produced by the
 * genuine decoding path, not hand-built stand-ins. That matters because the
 * whole safety property being asserted is "which viem error means the function
 * is absent, and which means the network failed".
 */
import {
  BaseError,
  createPublicClient,
  custom,
  HttpRequestError,
  numberToHex,
  TimeoutError,
  type EIP1193RequestFn,
} from 'viem'
import { describe, expect, it } from 'vitest'

import {
  InvalidMultiplierError,
  isMissingFunctionError,
  readMultiplierState,
  readScheduledAction,
  readShareEquivalent,
  readUiMultiplier,
  UI_MULTIPLIER_SELECTOR,
  WAD,
} from '../src/index.js'

const TOKEN = '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9' as const
const HOLDER = '0x0000000000000000000000000000000000000042' as const

const BALANCE_OF_UI = '0x437a9958'
const BALANCE_OF = '0x70a08231'
const NEW_UI_MULTIPLIER = '0xdc767007'
const EFFECTIVE_AT = '0x97a4064f'

/** Build a client whose `eth_call` is answered by `handler`. */
function clientWith(handler: (selector: string) => string | never) {
  const request = (async ({ method, params }) => {
    if (method === 'eth_call') {
      const data = (params as [{ data: string }])[0].data
      return handler(data.slice(0, 10))
    }
    if (method === 'eth_chainId') return numberToHex(4663)
    throw new Error(`unexpected RPC method ${method}`)
  }) as EIP1193RequestFn

  // retryCount 0: a deliberately failing transport should fail immediately.
  return createPublicClient({ transport: custom({ request }, { retryCount: 0 }) })
}

/**
 * Assert that `promise` rejects and that the thrown error's cause chain contains
 * `expected`.
 *
 * viem wraps a transport failure in a `ContractFunctionExecutionError`, so a
 * bare `instanceof` on the outermost error would miss it. What actually matters
 * for this package's safety property is that the transport failure REACHES the
 * caller instead of being converted into a plausible-looking 1e18, so the
 * assertion walks the chain for it.
 */
async function expectRejectsWithCause(promise: Promise<unknown>, expected: abstract new (...args: never) => Error) {
  await expect(promise).rejects.toThrow()

  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  )

  expect(error).toBeInstanceOf(BaseError)
  expect((error as BaseError).walk((e) => e instanceof expected)).toBeInstanceOf(expected)
}

/** A JSON-RPC "execution reverted" error, as a node actually returns it. */
function revert(): never {
  const error = new Error('execution reverted') as Error & { code: number; data: string }
  error.code = 3
  error.data = '0x'
  throw error
}

const word = (value: bigint) => numberToHex(value, { size: 32 })

describe('readUiMultiplier on a token that implements ERC-8056', () => {
  it('returns the multiplier and reports it as implemented', async () => {
    const client = clientWith((selector) => (selector === UI_MULTIPLIER_SELECTOR ? word(4n * WAD) : revert()))

    expect(await readUiMultiplier(client, TOKEN)).toBe(4n * WAD)
    expect(await readMultiplierState(client, TOKEN)).toEqual({ multiplier: 4n * WAD, implemented: true })
  })

  it('reads the 1e18 identity multiplier that every canonical Stock Token reports today', async () => {
    const client = clientWith(() => word(WAD))
    expect(await readUiMultiplier(client, TOKEN)).toBe(WAD)
  })

  it('rejects a token reporting a zero multiplier as broken rather than absent', async () => {
    const client = clientWith(() => word(0n))
    await expect(readUiMultiplier(client, TOKEN)).rejects.toThrow(InvalidMultiplierError)
  })
})

describe('readUiMultiplier on a pre-ERC-8056 token', () => {
  it('resolves to 1e18 when the call returns no data', async () => {
    const client = clientWith(() => '0x')

    expect(await readUiMultiplier(client, TOKEN)).toBe(WAD)
    expect(await readMultiplierState(client, TOKEN)).toEqual({ multiplier: WAD, implemented: false })
  })

  it('resolves to 1e18 when the call reverts', async () => {
    const client = clientWith(() => revert())

    expect(await readUiMultiplier(client, TOKEN)).toBe(WAD)
    expect(await readMultiplierState(client, TOKEN)).toEqual({ multiplier: WAD, implemented: false })
  })
})

describe('readUiMultiplier never swallows a transport failure', () => {
  it('propagates an HTTP error instead of pretending the multiplier is 1.0', async () => {
    const client = clientWith(() => {
      throw new HttpRequestError({ status: 503, url: 'https://rpc.example', details: 'service unavailable' })
    })

    await expectRejectsWithCause(readUiMultiplier(client, TOKEN), HttpRequestError)
  })

  it('propagates a timeout', async () => {
    const client = clientWith(() => {
      throw new TimeoutError({ body: {}, url: 'https://rpc.example' })
    })

    await expectRejectsWithCause(readUiMultiplier(client, TOKEN), TimeoutError)
  })

  it('propagates a plain unexpected error', async () => {
    const client = clientWith(() => {
      throw new Error('socket hang up')
    })

    await expect(readUiMultiplier(client, TOKEN)).rejects.toThrow()
    // And it is not silently converted into a multiplier.
    await expect(readUiMultiplier(client, TOKEN)).rejects.not.toBe(WAD)
  })
})

describe('isMissingFunctionError', () => {
  it('is false for non-viem values', () => {
    expect(isMissingFunctionError(new Error('boom'))).toBe(false)
    expect(isMissingFunctionError(null)).toBe(false)
    expect(isMissingFunctionError('nope')).toBe(false)
  })

  it('is false for a transport error', () => {
    expect(isMissingFunctionError(new HttpRequestError({ status: 500, url: 'https://rpc.example' }))).toBe(false)
  })
})

describe('readScheduledAction', () => {
  it('returns null when nothing is scheduled', async () => {
    const client = clientWith((selector) => {
      if (selector === NEW_UI_MULTIPLIER) return word(WAD)
      if (selector === EFFECTIVE_AT) return word(0n)
      return revert()
    })

    expect(await readScheduledAction(client, TOKEN)).toBeNull()
  })

  it('returns the pending action when one is scheduled', async () => {
    const when = 1_800_000_000n
    const client = clientWith((selector) => {
      if (selector === NEW_UI_MULTIPLIER) return word(4n * WAD)
      if (selector === EFFECTIVE_AT) return word(when)
      return revert()
    })

    expect(await readScheduledAction(client, TOKEN)).toEqual({
      newMultiplier: 4n * WAD,
      effectiveAt: Number(when),
    })
  })

  it('returns null on a token without the scheduled extension', async () => {
    const client = clientWith(() => '0x')
    expect(await readScheduledAction(client, TOKEN)).toBeNull()
  })

  it('propagates a transport failure', async () => {
    const client = clientWith(() => {
      throw new HttpRequestError({ status: 502, url: 'https://rpc.example' })
    })
    await expectRejectsWithCause(readScheduledAction(client, TOKEN), HttpRequestError)
  })
})

describe('readShareEquivalent', () => {
  it('prefers the on-chain balanceOfUI view', async () => {
    const client = clientWith((selector) => {
      if (selector === BALANCE_OF_UI) return word(400n * WAD)
      return revert()
    })

    expect(await readShareEquivalent(client, TOKEN, HOLDER)).toBe(400n * WAD)
  })

  it('falls back to balanceOf x multiplier, producing the identical number', async () => {
    const client = clientWith((selector) => {
      if (selector === BALANCE_OF_UI) return '0x' // view not exposed
      if (selector === BALANCE_OF) return word(100n * WAD)
      if (selector === UI_MULTIPLIER_SELECTOR) return word(4n * WAD)
      return revert()
    })

    expect(await readShareEquivalent(client, TOKEN, HOLDER)).toBe(400n * WAD)
  })

  it('treats a pre-8056 token balance as its own share equivalent', async () => {
    const client = clientWith((selector) => {
      if (selector === BALANCE_OF) return word(100n * WAD)
      return '0x' // neither balanceOfUI nor uiMultiplier exists
    })

    expect(await readShareEquivalent(client, TOKEN, HOLDER)).toBe(100n * WAD)
  })

  it('propagates a transport failure rather than reporting a zero position', async () => {
    const client = clientWith(() => {
      throw new HttpRequestError({ status: 503, url: 'https://rpc.example' })
    })
    await expectRejectsWithCause(readShareEquivalent(client, TOKEN, HOLDER), HttpRequestError)
  })
})
