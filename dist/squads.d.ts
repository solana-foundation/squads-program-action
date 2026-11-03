import { type Address, type Instruction } from '@solana/kit';
import { type SolanaRpc } from './rpc.js';
export declare const SQUADS_PROGRAM_ID: Address<"SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf">;
export declare function getVaultPda(multisigPda: Address, index: number): Promise<Address>;
export declare function getTransactionPda(multisigPda: Address, index: bigint): Promise<Address>;
export declare function fetchMultisigTransactionIndex(rpc: SolanaRpc, multisigPda: Address): Promise<bigint>;
export declare function transactionMessageToMultisigBytes(payer: Address, instructions: readonly Instruction[]): Uint8Array;
export declare function createVaultTransactionCreateInstruction({ multisigPda, transactionIndex, creator, vaultIndex, vaultPda, instructions, memo }: {
    multisigPda: Address;
    transactionIndex: bigint;
    creator: Address;
    vaultIndex: number;
    /** Fee payer of the wrapped transaction message. */
    vaultPda: Address;
    /** Instructions of the wrapped transaction message. */
    instructions: readonly Instruction[];
    memo?: string;
}): Promise<Instruction>;
