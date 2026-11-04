import { type Address, type Instruction } from '@solana/kit';
export declare function main({ rpc, program, buffer, idlBuffer, metadataBuffer, multisig: multisigAddress, keypair, vaultIndex, priorityFee, pdaTx, exportOnly, exportEncoding }: {
    rpc: string;
    program: string;
    buffer: string;
    idlBuffer: string;
    metadataBuffer?: string;
    multisig: string;
    keypair: string;
    vaultIndex: number;
    priorityFee: number;
    pdaTx?: string;
    exportOnly?: boolean;
    exportEncoding?: 'base58' | 'base64';
}): Promise<string | undefined>;
export declare function buildExportTransaction(instructions: Instruction[], feePayer: Address, recentBlockhash: string, encoding?: 'base58' | 'base64'): string;
export declare function parseVerificationTransaction(encodedTransaction: string): Promise<{
    instructions: Instruction[];
}>;
