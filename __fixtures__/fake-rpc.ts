import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import bs58 from 'bs58'

export type FakeAccount = {
  owner: string
  lamports: number
  data: Buffer
  executable?: boolean
}

export type RecordedRequest = { method: string; params: unknown }

export const FAKE_BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi'
export const FAKE_UNITS_CONSUMED = 41_234

// Same formula as the runtime with default rent parameters.
export const rentExemptLamports = (size: number) => (size + 128) * 6960

export type FakeRpcFaults = {
  // Answer the first N calls of a method with a JSON-RPC error
  failFirst?: Record<string, number>
  // Report the signature as not found for the first N status polls
  pendingStatusPolls?: number
  // Make simulateTransaction report this error
  simulationError?: unknown
}

/**
 * A minimal Solana JSON-RPC server that serves fixed accounts and records
 * every request, so the action's RPC traffic and the transactions it sends can
 * be compared across implementations.
 */
export async function startFakeRpc(
  accounts: Record<string, FakeAccount>,
  faults: FakeRpcFaults = {}
) {
  const requests: RecordedRequest[] = []
  const calls: Record<string, number> = {}
  let statusPolls = 0

  const handle = (method: string, params: unknown[]): unknown => {
    calls[method] = (calls[method] ?? 0) + 1
    if (calls[method] <= (faults.failFirst?.[method] ?? 0)) {
      throw new Error(`Injected failure #${calls[method]} for ${method}`)
    }
    switch (method) {
      case 'getAccountInfo': {
        const account = accounts[params[0] as string]
        return {
          context: { slot: 1 },
          value: account
            ? {
                data: [account.data.toString('base64'), 'base64'],
                executable: account.executable ?? false,
                lamports: account.lamports,
                owner: account.owner,
                rentEpoch: 0,
                space: account.data.length
              }
            : null
        }
      }
      case 'getLatestBlockhash':
        return {
          context: { slot: 1 },
          value: { blockhash: FAKE_BLOCKHASH, lastValidBlockHeight: 1000 }
        }
      case 'getMinimumBalanceForRentExemption':
        return rentExemptLamports(params[0] as number)
      case 'simulateTransaction':
        return {
          context: { slot: 1 },
          value: {
            err: faults.simulationError ?? null,
            logs: faults.simulationError
              ? ['Program log: injected failure', 'Program failed']
              : [],
            accounts: null,
            unitsConsumed: FAKE_UNITS_CONSUMED,
            returnData: null
          }
        }
      case 'sendTransaction': {
        const wire = Buffer.from(params[0] as string, 'base64')
        // Skip the 1-byte signature count; the first signature is the tx id.
        return bs58.encode(wire.subarray(1, 65))
      }
      case 'getSignatureStatuses':
        statusPolls++
        return {
          context: { slot: 1 },
          value: (params[0] as string[]).map(() =>
            statusPolls <= (faults.pendingStatusPolls ?? 0)
              ? null
              : {
                  slot: 1,
                  confirmations: null,
                  err: null,
                  status: { Ok: null },
                  confirmationStatus: 'confirmed'
                }
          )
        }
      default:
        throw new Error(`Unexpected RPC method ${method}`)
    }
  }

  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const { id, method, params = [] } = JSON.parse(body)
      requests.push({ method, params })
      let reply
      try {
        reply = { jsonrpc: '2.0', id, result: handle(method, params) }
      } catch (error) {
        reply = {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: (error as Error).message }
        }
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(reply))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
