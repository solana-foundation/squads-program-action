import {
  type Address,
  type Instruction,
  AccountRole,
  address,
  createAddressWithSeed,
  createKeyPairSignerFromBytes,
  createNoopSigner,
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  getTransactionDecoder
} from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'
import bs58 from 'bs58'
import { compileMessage, serializeTransaction } from './compile.js'
import { createRpcClient, fetchAccount, type SolanaRpc } from './rpc.js'
import { sendTransaction } from './transaction-helpers.js'
import {
  createVaultTransactionCreateInstruction,
  fetchMultisigTransactionIndex,
  getVaultPda
} from './squads.js'
import {
  ACCOUNT_HEADER_LENGTH,
  findCanonicalPda,
  getAllocateInstruction,
  getExtendInstruction,
  getInitializeInstruction,
  getSetDataInstruction,
  getWriteInstruction,
  Compression,
  DataSource,
  Encoding,
  Format,
  PROGRAM_METADATA_PROGRAM_ADDRESS
} from '@solana-program/program-metadata'

const REALLOC_LIMIT = 10240

const MAX_TRANSACTION_BYTES = 1232

const BPF_UPGRADE_LOADER_ID = address(
  'BPFLoaderUpgradeab1e11111111111111111111111'
)
const SYSVAR_RENT_ADDRESS = address(
  'SysvarRent111111111111111111111111111111111'
)
const SYSVAR_CLOCK_ADDRESS = address(
  'SysvarC1ock11111111111111111111111111111111'
)

export async function main({
  rpc,
  program,
  buffer,
  idlBuffer,
  metadataBuffer,
  multisig: multisigAddress,
  keypair,
  vaultIndex,
  priorityFee,
  pdaTx,
  exportOnly,
  exportEncoding
}: {
  rpc: string
  program: string
  buffer: string
  idlBuffer: string
  metadataBuffer?: string
  multisig: string
  keypair: string
  vaultIndex: number
  priorityFee: number
  pdaTx?: string
  exportOnly?: boolean
  exportEncoding?: 'base58' | 'base64'
}): Promise<string | undefined> {
  if (!exportOnly && !keypair) {
    throw new Error('keypair is required unless export is true')
  }

  const keypairObj = keypair
    ? await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(keypair)))
    : undefined

  const connection = createRpcClient(rpc)

  const multisigPda = address(multisigAddress)
  const programId = address(program)
  const programBuffer = address(buffer)
  let idlBufferObj: Address | undefined
  let metadataBufferObj: Address | undefined

  if (idlBuffer != null && idlBuffer !== '') {
    idlBufferObj = address(idlBuffer)
  }

  if (metadataBuffer != null && metadataBuffer !== '') {
    metadataBufferObj = address(metadataBuffer)
  }

  if (idlBufferObj && metadataBufferObj) {
    throw new Error(
      'Cannot use both idl-buffer and metadata-buffer. ' +
        'Use idl-buffer for Anchor IDL or metadata-buffer for program-metadata.'
    )
  }

  // Get vault PDA (authority)
  const vaultPda = await getVaultPda(multisigPda, vaultIndex)

  console.log('\n=== Setup Info ===')
  console.log('Multisig:', multisigPda.toString())
  console.log('Vault:', vaultPda.toString())
  console.log('Program:', programId.toString())
  console.log('Program Buffer:', programBuffer.toString())
  if (idlBufferObj) console.log('Anchor IDL Buffer:', idlBufferObj.toString())
  if (metadataBufferObj)
    console.log('Metadata Buffer:', metadataBufferObj.toString())
  console.log('Extracted PDA transaction:', pdaTx?.toString())

  // Get current and new program sizes
  const programAccount = await getAccountInfoWithRetry(connection, programId)
  const bufferAccount = await getAccountInfoWithRetry(connection, programBuffer)

  if (!programAccount || !bufferAccount) {
    throw new Error('Could not fetch program or buffer account')
  }

  // Create both upgrade instructions
  const programUpgradeIx = await createProgramUpgradeInstruction(
    programId,
    programBuffer,
    vaultPda,
    keypairObj?.address ?? vaultPda
  )

  // Build transaction message with all instructions
  let instructions: Instruction[] = []
  let memo = 'Program upgrade'

  // Add Anchor IDL upgrade instruction if IDL buffer is provided
  if (idlBufferObj) {
    const idlUpgradeIx = await createIdlUpgradeInstruction(
      programId,
      idlBufferObj,
      vaultPda
    )
    instructions.push(idlUpgradeIx)
    memo += ' with Anchor IDL update'
  }

  // Add program-metadata IDL instruction(s) if metadata buffer is provided
  if (metadataBufferObj) {
    const metadataIxs = await createMetadataInstructions(
      connection,
      programId,
      metadataBufferObj,
      vaultPda
    )
    instructions.push(...metadataIxs)
    memo += ' with program-metadata IDL update'
  }

  // Add program upgrade instruction
  instructions.push(programUpgradeIx)

  // Add verification instruction if provided
  if (pdaTx) {
    const verificationTx = await parseVerificationTransaction(pdaTx)
    if (verificationTx.instructions.length > 0) {
      console.log('Adding verification instruction')
      instructions = [verificationTx.instructions[1], ...instructions]
      memo += ' and PDA verification'
    }
  }

  if (exportOnly) {
    const encoded = buildExportTransaction(
      instructions,
      vaultPda,
      (await connection.getLatestBlockhash().send()).value.blockhash,
      exportEncoding
    )

    console.log('\n=== Exported Combined Transaction ===')
    console.log(
      'Import this transaction into the Squads transaction builder to create the upgrade proposal:'
    )
    console.log(encoded)
    return encoded
  }

  if (!keypairObj) {
    throw new Error('keypair is required unless export is true')
  }

  // The Squads transaction message does not include a blockhash, but the
  // web3.js implementation fetched one here; kept so RPC traffic is unchanged.
  await connection.getLatestBlockhash().send()

  // Get next transaction index
  const currentTransactionIndex = await fetchMultisigTransactionIndex(
    connection,
    multisigPda
  )
  const newTransactionIndex = currentTransactionIndex + 1n

  try {
    console.log('\n=== Creating Upgrade Transaction ===')

    // Create vault transaction instruction
    const createVaultTxIx = await createVaultTransactionCreateInstruction({
      multisigPda,
      transactionIndex: newTransactionIndex,
      creator: keypairObj.address,
      vaultIndex: vaultIndex,
      vaultPda,
      instructions,
      memo
    })

    // Create transaction and add compute budget
    const tx = {
      instructions: [createVaultTxIx],
      recentBlockhash: (await connection.getLatestBlockhash().send()).value
        .blockhash
    }

    // Send transaction
    const createVaultSignature = await sendTransaction(
      connection,
      tx,
      [keypairObj],
      priorityFee
    )

    console.log('Transaction Created - Signature:', createVaultSignature)

    // Create proposal instruction
    console.log('\n=== Creating Proposal ===')
    console.log('\nWith transaction index:', newTransactionIndex)
    console.log('\nPlease approve in Squads UI: https://v4.squads.so/')
  } catch (error) {
    console.error('\n=== Error ===')
    console.error('Error details:', error)
    process.exit(1)
  }
}

async function createMetadataInstructions(
  connection: SolanaRpc,
  programId: Address,
  bufferAddress: Address,
  authority: Address
): Promise<Instruction[]> {
  const programAddr = programId
  const bufferAddr = bufferAddress

  const [metadataPda] = await findCanonicalPda({
    program: programAddr,
    seed: 'idl'
  })

  const programDataAddress = await getProgramDataAddress(programId)
  const programDataAddr = programDataAddress

  console.log('\n=== Program Metadata Info ===')
  console.log('Metadata PDA:', metadataPda)
  console.log('Buffer:', bufferAddr)
  console.log('Program Data:', programDataAddress.toString())

  const authoritySigner = createNoopSigner(authority)

  const metadataAccount = await fetchAccount(
    connection,
    metadataPda,
    'confirmed'
  )
  // A CI pre-fund creates a system-owned account at the PDA before Allocate.
  // Treat anything not owned by program-metadata as "does not exist yet".
  const existingMetadata =
    metadataAccount &&
    metadataAccount.owner === PROGRAM_METADATA_PROGRAM_ADDRESS
      ? metadataAccount
      : null

  if (existingMetadata) {
    console.log('Metadata account exists, updating via SetData')

    const bufferAccount = await fetchAccount(
      connection,
      bufferAddress,
      'confirmed'
    )
    if (!bufferAccount) {
      throw new Error(
        `Metadata buffer account ${bufferAddress.toString()} not found. ` +
          'Make sure the buffer was created and is on the correct cluster.'
      )
    }

    const newDataLength =
      bufferAccount.data.length > ACCOUNT_HEADER_LENGTH
        ? bufferAccount.data.length - ACCOUNT_HEADER_LENGTH
        : bufferAccount.data.length
    const currentDataLength =
      existingMetadata.data.length > ACCOUNT_HEADER_LENGTH
        ? existingMetadata.data.length - ACCOUNT_HEADER_LENGTH
        : existingMetadata.data.length
    const sizeDifference = newDataLength - currentDataLength

    console.log(
      `Current metadata data: ${currentDataLength} bytes, ` +
        `new buffer data: ${newDataLength} bytes, ` +
        `size difference: ${sizeDifference} bytes`
    )

    const updateInstructions: Instruction[] = []

    if (sizeDifference > 0) {
      // Prefer rent already sitting on the metadata account (e.g. CI pre-fund).
      // Only transfer the shortfall from the vault — a zero shortfall means no
      // SystemProgram.transfer, which Squads otherwise marks as insecure.
      const requiredRent = Number(
        await connection
          .getMinimumBalanceForRentExemption(
            BigInt(existingMetadata.data.length + sizeDifference)
          )
          .send()
      )
      const shortfall = Math.max(0, requiredRent - existingMetadata.lamports)
      if (shortfall > 0) {
        console.log(
          `Transferring ${shortfall} lamports shortfall for size increase ` +
            `(required ${requiredRent}, have ${existingMetadata.lamports})`
        )
        updateInstructions.push(
          getTransferSolInstruction({
            source: authoritySigner,
            destination: metadataPda,
            amount: BigInt(shortfall)
          })
        )
      } else {
        console.log(
          `Metadata account already rent-funded for new size ` +
            `(${existingMetadata.lamports} >= ${requiredRent}); skipping SystemProgram.transfer`
        )
      }

      if (sizeDifference > REALLOC_LIMIT) {
        let remaining = sizeDifference
        while (remaining > 0) {
          const chunk = Math.min(remaining, REALLOC_LIMIT)
          updateInstructions.push(
            getExtendInstruction({
              account: metadataPda,
              authority: authoritySigner,
              program: programAddr,
              programData: programDataAddr,
              length: chunk
            })
          )
          remaining -= chunk
        }
      }
    }

    updateInstructions.push(
      getSetDataInstruction({
        metadata: metadataPda,
        authority: authoritySigner,
        buffer: bufferAddr,
        program: programAddr,
        programData: programDataAddr,
        encoding: Encoding.Utf8,
        compression: Compression.Zlib,
        format: Format.Json,
        dataSource: DataSource.Direct
      })
    )

    return updateInstructions
  }

  // Metadata account does not exist — follow the SDK's create flow:
  // Transfer -> Allocate -> Extend (if needed) -> Write -> Initialize
  console.log('Metadata account does not exist, adding init instructions')

  const bufferAccount = await fetchAccount(
    connection,
    bufferAddress,
    'confirmed'
  )
  if (!bufferAccount) {
    throw new Error(
      `Metadata buffer account ${bufferAddress.toString()} not found. ` +
        'Make sure the buffer was created and is on the correct cluster.'
    )
  }

  const dataLength =
    bufferAccount.data.length > ACCOUNT_HEADER_LENGTH
      ? bufferAccount.data.length - ACCOUNT_HEADER_LENGTH
      : bufferAccount.data.length
  const accountSize = BigInt(ACCOUNT_HEADER_LENGTH) + BigInt(dataLength)
  const rentLamports = Number(
    await connection.getMinimumBalanceForRentExemption(accountSize).send()
  )

  console.log(
    `Buffer data: ${bufferAccount.data.length} bytes, ` +
      `data portion: ${dataLength} bytes, ` +
      `target account size: ${accountSize} bytes, ` +
      `rent: ${rentLamports} lamports`
  )

  const instructions: Instruction[] = []

  // 1. Fund the metadata PDA with rent only if CI did not already pre-fund it.
  // CreateAccountAllowPrefund accepts a system-owned pre-funded PDA.
  // `metadataAccount` here may be a system-owned pre-fund from CI.
  const existingLamports = metadataAccount?.lamports ?? 0
  const initShortfall = Math.max(0, rentLamports - existingLamports)
  if (initShortfall > 0) {
    console.log(
      `Funding new metadata PDA with ${initShortfall} lamports ` +
        `(required ${rentLamports}, have ${existingLamports})`
    )
    instructions.push(
      getTransferSolInstruction({
        source: authoritySigner,
        destination: metadataPda,
        amount: BigInt(initShortfall)
      })
    )
  } else {
    console.log(
      `Metadata PDA already pre-funded with ${existingLamports} lamports; ` +
        `skipping SystemProgram.transfer`
    )
  }

  // 2. Allocate the PDA as a program-metadata buffer
  instructions.push(
    getAllocateInstruction({
      buffer: metadataPda,
      authority: authoritySigner,
      program: programAddr,
      programData: programDataAddr,
      seed: 'idl'
    })
  )

  // 3. Extend if data exceeds the realloc limit (10KB per instruction)
  if (dataLength > REALLOC_LIMIT) {
    let remaining = dataLength
    while (remaining > 0) {
      const chunk = Math.min(remaining, REALLOC_LIMIT)
      instructions.push(
        getExtendInstruction({
          account: metadataPda,
          authority: authoritySigner,
          program: programAddr,
          programData: programDataAddr,
          length: chunk
        })
      )
      remaining -= chunk
    }
  }

  // 4. Write data from the source buffer into the PDA buffer
  instructions.push(
    getWriteInstruction({
      buffer: metadataPda,
      authority: authoritySigner,
      sourceBuffer: bufferAddr,
      offset: 0
    })
  )

  // 5. Initialize — converts the pre-allocated buffer into a metadata account
  instructions.push(
    getInitializeInstruction({
      metadata: metadataPda,
      authority: authoritySigner,
      program: programAddr,
      programData: programDataAddr,
      seed: 'idl',
      encoding: Encoding.Utf8,
      compression: Compression.Zlib,
      format: Format.Json,
      dataSource: DataSource.Direct
    })
  )

  return instructions
}

// Same as Anchor's `idlAddress`: derived with seed "anchor:idl" from the
// program's PDA with no seeds.
async function getAnchorIdlAddress(programId: Address): Promise<Address> {
  const [base] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: []
  })
  return createAddressWithSeed({
    baseAddress: base,
    programAddress: programId,
    seed: 'anchor:idl'
  })
}

async function getProgramDataAddress(programId: Address): Promise<Address> {
  const [programDataAddress] = await getProgramDerivedAddress({
    programAddress: BPF_UPGRADE_LOADER_ID,
    seeds: [getAddressEncoder().encode(programId)]
  })
  return programDataAddress
}

async function createIdlUpgradeInstruction(
  programId: Address,
  bufferAddress: Address,
  upgradeAuthority: Address
): Promise<Instruction> {
  const idlAddr = await getAnchorIdlAddress(programId)

  console.log('\n=== IDL Info ===')
  console.log('IDL Address:', idlAddr.toString())
  console.log('Buffer:', bufferAddress.toString())

  // Create instruction data: [40, f4, bc, 78, a7, e9, 69, 0a, 03]
  const data = new Uint8Array([
    0x40, 0xf4, 0xbc, 0x78, 0xa7, 0xe9, 0x69, 0x0a, 0x03
  ])

  return {
    accounts: [
      { address: bufferAddress, role: AccountRole.WRITABLE },
      { address: idlAddr, role: AccountRole.WRITABLE },
      { address: upgradeAuthority, role: AccountRole.WRITABLE_SIGNER }
    ],
    programAddress: programId,
    data
  }
}

async function createProgramUpgradeInstruction(
  programId: Address,
  bufferAddress: Address,
  upgradeAuthority: Address,
  spillAddress: Address
): Promise<Instruction> {
  const programDataAddress = await getProgramDataAddress(programId)

  return {
    accounts: [
      { address: programDataAddress, role: AccountRole.WRITABLE },
      { address: programId, role: AccountRole.WRITABLE },
      { address: bufferAddress, role: AccountRole.WRITABLE },
      { address: spillAddress, role: AccountRole.WRITABLE },
      { address: SYSVAR_RENT_ADDRESS, role: AccountRole.READONLY },
      { address: SYSVAR_CLOCK_ADDRESS, role: AccountRole.READONLY },
      { address: upgradeAuthority, role: AccountRole.READONLY_SIGNER }
    ],
    programAddress: BPF_UPGRADE_LOADER_ID,
    data: new Uint8Array([3, 0, 0, 0])
  }
}

export function buildExportTransaction(
  instructions: Instruction[],
  feePayer: Address,
  recentBlockhash: string,
  encoding: 'base58' | 'base64' = 'base58'
): string {
  let wire: Uint8Array
  try {
    wire = serializeTransaction(
      compileMessage('legacy', feePayer, recentBlockhash, instructions)
    )
    if (wire.length > MAX_TRANSACTION_BYTES) {
      throw new Error(
        `Transaction too large: ${wire.length} > ${MAX_TRANSACTION_BYTES}`
      )
    }
  } catch (error) {
    throw new Error(
      `Combined transaction exceeds the ${MAX_TRANSACTION_BYTES} byte ` +
        'transaction limit. Export the verify, IDL, and upgrade ' +
        'transactions separately instead. Serialization error: ' +
        (error instanceof Error ? error.message : String(error))
    )
  }

  return encoding === 'base64'
    ? Buffer.from(wire).toString('base64')
    : bs58.encode(wire)
}

// Decodes a wire transaction into its instructions, with account roles taken
// from the message header. Only static accounts are supported.
function decodeTransaction(bytes: Uint8Array): { instructions: Instruction[] } {
  const { messageBytes } = getTransactionDecoder().decode(bytes)
  const [message, offset] = getCompiledTransactionMessageDecoder().read(
    messageBytes,
    0
  )
  if (message.version !== 'legacy' && message.version !== 0) {
    throw new Error(`Unsupported transaction version ${message.version}`)
  }
  if (offset !== messageBytes.length) {
    throw new Error('Unexpected trailing bytes after the transaction message')
  }
  if ('addressTableLookups' in message && message.addressTableLookups?.length) {
    throw new Error('Address lookup tables are not supported')
  }
  const { header, staticAccounts } = message
  const numAccounts = staticAccounts.length
  if (
    header.numSignerAccounts > numAccounts ||
    header.numReadonlySignerAccounts > header.numSignerAccounts ||
    header.numReadonlyNonSignerAccounts > numAccounts - header.numSignerAccounts
  ) {
    throw new Error('Invalid transaction message header')
  }
  const accountAt = (index: number) => {
    if (index >= numAccounts) {
      throw new Error(`Account index ${index} out of range`)
    }
    const isSigner = index < header.numSignerAccounts
    const isWritable = isSigner
      ? index < header.numSignerAccounts - header.numReadonlySignerAccounts
      : index < numAccounts - header.numReadonlyNonSignerAccounts
    return {
      address: staticAccounts[index],
      role: ((isSigner ? 2 : 0) | (isWritable ? 1 : 0)) as AccountRole
    }
  }
  return {
    instructions: message.instructions.map((ix) => ({
      programAddress: accountAt(ix.programAddressIndex).address,
      accounts: (ix.accountIndices ?? []).map(accountAt),
      data: new Uint8Array(ix.data ?? [])
    }))
  }
}

export async function parseVerificationTransaction(
  encodedTransaction: string
): Promise<{ instructions: Instruction[] }> {
  const value = encodedTransaction.trim()

  try {
    return decodeTransaction(Buffer.from(value, 'base64'))
  } catch (base64Error) {
    try {
      return decodeTransaction(Buffer.from(bs58.decode(value)))
    } catch (base58Error) {
      const base64Message =
        base64Error instanceof Error ? base64Error.message : String(base64Error)
      const base58Message =
        base58Error instanceof Error ? base58Error.message : String(base58Error)

      throw new Error(
        'Unable to decode PDA verification transaction as base64 or base58. ' +
          `Base64 error: ${base64Message}. Base58 error: ${base58Message}.`
      )
    }
  }
}

async function getAccountInfoWithRetry(
  connection: SolanaRpc,
  pubkey: Address,
  retries = 5,
  delay = 1000
) {
  for (let i = 0; i < retries; i++) {
    try {
      const account = await fetchAccount(connection, pubkey)
      return account
    } catch (error) {
      if (i === retries - 1) {
        throw new Error(
          `Failed to get account info for ${pubkey.toString()} after ${retries} attempts: ${error}`
        )
      }
      console.log(
        `Retry ${i + 1}/${retries} getting account info for ${pubkey.toString()}`
      )
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

// Remove this block if not needed
// if (require.main === module) {
//   main({
//     rpc: process.argv[2],
//     program: process.argv[3],
//     buffer: process.argv[4],
//     idlBuffer: process.argv[5],
//     multisig: process.argv[6],
//     keypair: process.argv[7],
//     pdaTx: process.argv[8]
//   }).catch(console.error);
// }
