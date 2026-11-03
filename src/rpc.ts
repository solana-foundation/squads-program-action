import {
  type Address,
  type Commitment,
  type Rpc,
  type SolanaRpcApi,
  createDefaultRpcTransport,
  createRpc,
  createSolanaRpcApi,
  DEFAULT_RPC_CONFIG,
  getBase64Encoder
} from '@solana/kit'

export type SolanaRpc = Rpc<SolanaRpcApi>

export type AccountInfo = {
  owner: Address
  lamports: number
  data: Uint8Array
}

/**
 * Like kit's `createSolanaRpc`, but without its default `confirmed`
 * commitment: requests that don't set one use the node's default
 * (`finalized`), as the action's previous @solana/web3.js `Connection` did.
 */
export function createRpcClient(url: string): SolanaRpc {
  return createRpc({
    api: createSolanaRpcApi({
      ...DEFAULT_RPC_CONFIG,
      defaultCommitment: undefined
    }),
    transport: createDefaultRpcTransport({ url })
  })
}

export async function fetchAccount(
  rpc: SolanaRpc,
  address: Address,
  commitment?: Commitment
): Promise<AccountInfo | null> {
  const { value } = await rpc
    .getAccountInfo(address, {
      encoding: 'base64',
      ...(commitment && { commitment })
    })
    .send()
  if (!value) return null
  return {
    owner: value.owner,
    lamports: Number(value.lamports),
    data: new Uint8Array(getBase64Encoder().encode(value.data[0]))
  }
}
