import { type Address, type Instruction, type KeyPairSigner, type SignatureBytes } from '@solana/kit';
export type CompiledMessageKeys = {
    header: {
        numSignerAccounts: number;
        numReadonlySignerAccounts: number;
        numReadonlyNonSignerAccounts: number;
    };
    staticAccounts: Address[];
    instructions: {
        programAddressIndex: number;
        accountIndices: number[];
        data: Uint8Array;
    }[];
};
export type CompiledMessage = {
    messageBytes: Uint8Array;
    signerAddresses: Address[];
};
export declare function compileMessageKeys(version: 'legacy' | 0, feePayer: Address, instructions: readonly Instruction[]): CompiledMessageKeys;
export declare function compileMessage(version: 'legacy' | 0, feePayer: Address, lifetimeToken: string, instructions: readonly Instruction[]): CompiledMessage;
/**
 * Encodes a compiled message as a wire transaction. Signature slots without a
 * signature are left zeroed.
 */
export declare function serializeTransaction({ messageBytes, signerAddresses }: CompiledMessage, signatures?: Partial<Record<Address, SignatureBytes>>): Uint8Array;
/** Signs a compiled message and encodes it as a wire transaction. */
export declare function signTransaction(message: CompiledMessage, signers: readonly KeyPairSigner[]): Promise<Uint8Array>;
