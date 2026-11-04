import { type Address, type Commitment, type Rpc, type SolanaRpcApi } from '@solana/kit';
export type SolanaRpc = Rpc<SolanaRpcApi>;
export type AccountInfo = {
    owner: Address;
    lamports: number;
    data: Uint8Array;
};
/**
 * Like kit's `createSolanaRpc`, but without its default `confirmed`
 * commitment: requests that don't set one use the node's default
 * (`finalized`), as the action's previous @solana/web3.js `Connection` did.
 */
export declare function createRpcClient(url: string): SolanaRpc;
export declare function fetchAccount(rpc: SolanaRpc, address: Address, commitment?: Commitment): Promise<AccountInfo | null>;
