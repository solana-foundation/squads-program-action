import {
  type AccountMeta,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type SignatureBytes,
  type TransactionMessageBytes,
  getCompiledTransactionMessageEncoder,
  getTransactionEncoder,
  isSignerRole,
  isWritableRole,
  signBytes
} from '@solana/kit'

// The action used to build transactions with @solana/web3.js. Kit's own
// compiler orders accounts differently for v0 messages and rejects invoked
// programs that are also passed as writable accounts (as the upgrade
// instruction does for the program being upgraded). These functions reproduce
// web3.js's account ordering so the action keeps producing identical bytes;
// kit only encodes and signs.

type KeyMeta = { isSigner: boolean; isWritable: boolean }

export type CompiledMessageKeys = {
  header: {
    numSignerAccounts: number
    numReadonlySignerAccounts: number
    numReadonlyNonSignerAccounts: number
  }
  staticAccounts: Address[]
  instructions: {
    programAddressIndex: number
    accountIndices: number[]
    data: Uint8Array
  }[]
}

export type CompiledMessage = {
  messageBytes: Uint8Array
  signerAddresses: Address[]
}

const accountsOf = (ix: Instruction) => (ix.accounts ?? []) as AccountMeta[]

const addressComparator = new Intl.Collator('en', {
  localeMatcher: 'best fit',
  usage: 'sort',
  sensitivity: 'variant',
  ignorePunctuation: false,
  numeric: false,
  caseFirst: 'lower'
}).compare

// Same as web3.js `Transaction.compileMessage()`: signers first, then writable
// accounts, then by address; the fee payer always goes first.
function orderLegacyKeys(
  feePayer: Address,
  instructions: readonly Instruction[]
): [Address, KeyMeta][] {
  const metas = new Map<Address, KeyMeta>()
  const merge = (address: Address, isSigner: boolean, isWritable: boolean) => {
    const meta = metas.get(address)
    if (meta) {
      meta.isSigner ||= isSigner
      meta.isWritable ||= isWritable
    } else {
      metas.set(address, { isSigner, isWritable })
    }
  }
  for (const ix of instructions) {
    for (const account of accountsOf(ix)) {
      merge(
        account.address,
        isSignerRole(account.role),
        isWritableRole(account.role)
      )
    }
  }
  for (const ix of instructions) merge(ix.programAddress, false, false)

  const sorted = [...metas].sort(([xAddress, x], [yAddress, y]) => {
    if (x.isSigner !== y.isSigner) return x.isSigner ? -1 : 1
    if (x.isWritable !== y.isWritable) return x.isWritable ? -1 : 1
    return addressComparator(xAddress, yAddress)
  })
  const rest = sorted.filter(([address]) => address !== feePayer)
  return [[feePayer, { isSigner: true, isWritable: true }], ...rest]
}

// Same as web3.js `CompiledKeys` (v0 messages): grouped by signer/writable,
// otherwise in the order accounts first appear, with the fee payer first.
function orderV0Keys(
  feePayer: Address,
  instructions: readonly Instruction[]
): [Address, KeyMeta][] {
  const metas = new Map<Address, KeyMeta>([
    [feePayer, { isSigner: true, isWritable: true }]
  ])
  const getOrInsert = (address: Address) => {
    let meta = metas.get(address)
    if (!meta) {
      meta = { isSigner: false, isWritable: false }
      metas.set(address, meta)
    }
    return meta
  }
  for (const ix of instructions) {
    getOrInsert(ix.programAddress)
    for (const account of accountsOf(ix)) {
      const meta = getOrInsert(account.address)
      meta.isSigner ||= isSignerRole(account.role)
      meta.isWritable ||= isWritableRole(account.role)
    }
  }
  const entries = [...metas]
  const group = (isSigner: boolean, isWritable: boolean) =>
    entries.filter(
      ([, meta]) => meta.isSigner === isSigner && meta.isWritable === isWritable
    )
  return [
    ...group(true, true),
    ...group(true, false),
    ...group(false, true),
    ...group(false, false)
  ]
}

export function compileMessageKeys(
  version: 'legacy' | 0,
  feePayer: Address,
  instructions: readonly Instruction[]
): CompiledMessageKeys {
  const ordered = (version === 'legacy' ? orderLegacyKeys : orderV0Keys)(
    feePayer,
    instructions
  )
  if (ordered.length > 256) {
    throw new Error('Max static account keys length exceeded')
  }
  const staticAccounts = ordered.map(([address]) => address)
  const indexOf = new Map(staticAccounts.map((address, i) => [address, i]))
  const signers = ordered.filter(([, meta]) => meta.isSigner)
  return {
    header: {
      numSignerAccounts: signers.length,
      numReadonlySignerAccounts: signers.filter(([, m]) => !m.isWritable)
        .length,
      numReadonlyNonSignerAccounts: ordered.filter(
        ([, m]) => !m.isSigner && !m.isWritable
      ).length
    },
    staticAccounts,
    instructions: instructions.map((ix) => ({
      programAddressIndex: indexOf.get(ix.programAddress)!,
      accountIndices: accountsOf(ix).map((a) => indexOf.get(a.address)!),
      data: new Uint8Array(ix.data ?? [])
    }))
  }
}

export function compileMessage(
  version: 'legacy' | 0,
  feePayer: Address,
  lifetimeToken: string,
  instructions: readonly Instruction[]
): CompiledMessage {
  const keys = compileMessageKeys(version, feePayer, instructions)
  const messageBytes = new Uint8Array(
    getCompiledTransactionMessageEncoder().encode(
      version === 'legacy'
        ? { version, lifetimeToken, ...keys }
        : { version, lifetimeToken, ...keys, addressTableLookups: [] }
    )
  )
  return {
    messageBytes,
    signerAddresses: keys.staticAccounts.slice(0, keys.header.numSignerAccounts)
  }
}

/**
 * Encodes a compiled message as a wire transaction. Signature slots without a
 * signature are left zeroed.
 */
export function serializeTransaction(
  { messageBytes, signerAddresses }: CompiledMessage,
  signatures: Partial<Record<Address, SignatureBytes>> = {}
): Uint8Array {
  return new Uint8Array(
    getTransactionEncoder().encode({
      messageBytes: messageBytes as unknown as TransactionMessageBytes,
      signatures: Object.fromEntries(
        signerAddresses.map((address) => [address, signatures[address] ?? null])
      )
    })
  )
}

/** Signs a compiled message and encodes it as a wire transaction. */
export async function signTransaction(
  message: CompiledMessage,
  signers: readonly KeyPairSigner[]
): Promise<Uint8Array> {
  const signatures: Partial<Record<Address, SignatureBytes>> = {}
  for (const signer of signers) {
    if (!message.signerAddresses.includes(signer.address)) {
      throw new Error(`unknown signer: ${signer.address}`)
    }
    signatures[signer.address] = await signBytes(
      signer.keyPair.privateKey,
      message.messageBytes
    )
  }
  return serializeTransaction(message, signatures)
}
