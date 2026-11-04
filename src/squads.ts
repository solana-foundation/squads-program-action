import {
  type Address,
  type Instruction,
  createNoopSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU64Encoder
} from '@solana/kit'
import {
  getMultisigDecoder,
  getTransactionMessageEncoder,
  getVaultTransactionCreateInstruction,
  MULTISIG_DISCRIMINATOR,
  SQUADS_MULTISIG_PROGRAM_PROGRAM_ADDRESS
} from './generated/squads/index.js'
import { compileMessageKeys } from './compile.js'
import { fetchAccount, type SolanaRpc } from './rpc.js'

export const SQUADS_PROGRAM_ID = SQUADS_MULTISIG_PROGRAM_PROGRAM_ADDRESS

const SEED_PREFIX = Buffer.from('multisig')
const SEED_VAULT = Buffer.from('vault')
const SEED_TRANSACTION = Buffer.from('transaction')

export async function getVaultPda(
  multisigPda: Address,
  index: number
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: SQUADS_PROGRAM_ID,
    seeds: [
      SEED_PREFIX,
      getAddressEncoder().encode(multisigPda),
      SEED_VAULT,
      Buffer.from([index])
    ]
  })
  return pda
}

export async function getTransactionPda(
  multisigPda: Address,
  index: bigint
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: SQUADS_PROGRAM_ID,
    seeds: [
      SEED_PREFIX,
      getAddressEncoder().encode(multisigPda),
      SEED_TRANSACTION,
      getU64Encoder().encode(index)
    ]
  })
  return pda
}

export async function fetchMultisigTransactionIndex(
  rpc: SolanaRpc,
  multisigPda: Address
): Promise<bigint> {
  const account = await fetchAccount(rpc, multisigPda)
  if (!account) {
    throw new Error(`Unable to find Multisig account at ${multisigPda}`)
  }
  if (account.owner !== SQUADS_PROGRAM_ID) {
    throw new Error(
      `Account ${multisigPda} is not owned by the Squads program (${account.owner})`
    )
  }
  if (
    !Buffer.from(account.data.subarray(0, 8)).equals(
      Buffer.from(MULTISIG_DISCRIMINATOR)
    )
  ) {
    throw new Error(`Account ${multisigPda} is not a Squads multisig`)
  }
  return getMultisigDecoder().decode(account.data).transactionIndex
}

// Serializes the message in the compact format the Squads program expects for
// `vault_transaction_create` (u8/u16 length prefixes instead of Borsh's u32).
// Address lookup tables are not supported, so the message only has static keys.
export function transactionMessageToMultisigBytes(
  payer: Address,
  instructions: readonly Instruction[]
): Uint8Array {
  const {
    header,
    staticAccounts,
    instructions: compiled
  } = compileMessageKeys(0, payer, instructions)
  return new Uint8Array(
    getTransactionMessageEncoder().encode({
      numSigners: header.numSignerAccounts,
      numWritableSigners:
        header.numSignerAccounts - header.numReadonlySignerAccounts,
      numWritableNonSigners:
        staticAccounts.length -
        header.numSignerAccounts -
        header.numReadonlyNonSignerAccounts,
      accountKeys: staticAccounts,
      instructions: compiled.map((ix) => ({
        programIdIndex: ix.programAddressIndex,
        accountIndexes: ix.accountIndices,
        data: Array.from(ix.data)
      })),
      addressTableLookups: []
    })
  )
}

export async function createVaultTransactionCreateInstruction({
  multisigPda,
  transactionIndex,
  creator,
  vaultIndex,
  vaultPda,
  instructions,
  memo
}: {
  multisigPda: Address
  transactionIndex: bigint
  creator: Address
  vaultIndex: number
  /** Fee payer of the wrapped transaction message. */
  vaultPda: Address
  /** Instructions of the wrapped transaction message. */
  instructions: readonly Instruction[]
  memo?: string
}): Promise<Instruction> {
  const creatorSigner = createNoopSigner(creator)
  return getVaultTransactionCreateInstruction({
    multisig: multisigPda,
    transaction: await getTransactionPda(multisigPda, transactionIndex),
    creator: creatorSigner,
    rentPayer: creatorSigner,
    vaultIndex,
    ephemeralSigners: 0,
    transactionMessage: transactionMessageToMultisigBytes(
      vaultPda,
      instructions
    ),
    memo: memo ?? null
  })
}
