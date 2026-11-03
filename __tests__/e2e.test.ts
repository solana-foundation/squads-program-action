/**
 * End-to-end check of `main()` against a fake RPC server.
 *
 * Every RPC request the action makes (including the full bytes of every
 * simulated and sent transaction) and its result are compared against
 * __fixtures__/e2e-golden.json, which was recorded from the @solana/web3.js
 * implementation before the switch to @solana/kit. Run with UPDATE_GOLDEN=1 to
 * re-record after an intentional change.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import bs58 from 'bs58'
import type { Address } from '@solana/kit'
import {
  findCanonicalPda,
  PROGRAM_METADATA_PROGRAM_ADDRESS
} from '@solana-program/program-metadata'
import {
  type FakeAccount,
  type RecordedRequest,
  rentExemptLamports,
  startFakeRpc
} from '../__fixtures__/fake-rpc.js'
import { main } from '../src/squad-upgrade.js'

const GOLDEN_PATH = new URL('../__fixtures__/e2e-golden.json', import.meta.url)
const UPDATE = process.env.UPDATE_GOLDEN === '1'

const squadsGolden = JSON.parse(
  readFileSync(
    new URL('../__fixtures__/squads-golden.json', import.meta.url),
    'utf8'
  )
)

const SYSTEM_PROGRAM = '11111111111111111111111111111111'
const BPF_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111'
const SQUADS_PROGRAM = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf'
const METADATA_HEADER = 96

const addr = (n: number) => bs58.encode(Buffer.alloc(32, n))

const PROGRAM = addr(40)
const BUFFER = addr(41)
const IDL_BUFFER = addr(42)
const METADATA_BUFFER = addr(43)
const MULTISIG = squadsGolden.multisigPda as string

// Deterministic creator keypair, in the JSON format the action takes.
const seed = Buffer.alloc(32, 7)
const publicKey = Buffer.from(
  createPublicKey(
    createPrivateKey({
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        seed
      ]),
      format: 'der',
      type: 'pkcs8'
    })
  ).export({ format: 'jwk' }).x as string,
  'base64url'
)
const KEYPAIR = JSON.stringify([...seed, ...publicKey])

// Output of `solana-verify export-pda-tx` for vault 0; the action takes
// instruction 1 from it.
const PDA_TX =
  'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAQGx8mDKvL7CD+1MVDusIM/UCflYNO7nCZpYbqkFYP7Cu5VJvdClBcRs7xTC6RP9vbasPCrca+DL0Gn/juf2u2cYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcN+eInmtvsbRK/KSEYTJIi6yTthSAFv2QBOfUuWc2a4DBkZv5SEXMv/srbpyw5vnvIzlu8X3EmssQ5s6QAAAAA2+lpJavr/X1WcNH9tBZ1bBsUaYr+WpjACZKYVVNJIXLfBBJfABWvtHzoU674dyCU/5SYwUyxueEpc8KSfaD6YCBAAJA+gDAAAAAAAABQQAAQMCNHZlcmlmeS1hcmdzOnh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHg='

type Scenario = {
  name: string
  input: {
    idlBuffer?: string
    metadataBuffer?: string
    vaultIndex?: number
    pdaTx?: string
    exportOnly?: boolean
    exportEncoding?: 'base58' | 'base64'
    keypair?: string
    multisig?: string
  }
  // Size of the program-metadata data in METADATA_BUFFER (excluding header)
  metadataBufferData?: number
  // State of the canonical metadata PDA before the upgrade
  metadataPda?:
    | { kind: 'prefund'; lamports: number }
    | { kind: 'existing'; dataLength: number; lamports: number }
}

const scenarios: Scenario[] = [
  {
    name: 'export: program upgrade only (base58)',
    input: { exportOnly: true }
  },
  {
    name: 'export: anchor IDL, vault 2 (base64)',
    input: {
      exportOnly: true,
      idlBuffer: IDL_BUFFER,
      vaultIndex: 2,
      exportEncoding: 'base64'
    }
  },
  {
    name: 'export: anchor IDL + PDA verification, no keypair',
    input: {
      exportOnly: true,
      idlBuffer: IDL_BUFFER,
      pdaTx: PDA_TX,
      keypair: ''
    }
  },
  {
    name: 'export: new metadata account, not prefunded',
    input: { exportOnly: true, metadataBuffer: METADATA_BUFFER },
    metadataBufferData: 2_000
  },
  {
    name: 'export: new metadata account, partly prefunded, needs extends',
    input: { exportOnly: true, metadataBuffer: METADATA_BUFFER },
    metadataBufferData: 25_000,
    metadataPda: { kind: 'prefund', lamports: 1_000_000 }
  },
  {
    name: 'export: new metadata account, fully prefunded',
    input: { exportOnly: true, metadataBuffer: METADATA_BUFFER },
    metadataBufferData: 2_000,
    metadataPda: {
      kind: 'prefund',
      lamports: rentExemptLamports(METADATA_HEADER + 2_000)
    }
  },
  {
    name: 'export: existing metadata grows past realloc limit',
    input: { exportOnly: true, metadataBuffer: METADATA_BUFFER },
    metadataBufferData: 40_000,
    metadataPda: { kind: 'existing', dataLength: 1_000, lamports: 5_000_000 }
  },
  {
    name: 'error: export transaction too large',
    input: { exportOnly: true, metadataBuffer: METADATA_BUFFER },
    metadataBufferData: 1_000_000
  },
  {
    name: 'export: existing metadata grows, already funded',
    input: { exportOnly: true, metadataBuffer: METADATA_BUFFER },
    metadataBufferData: 3_000,
    metadataPda: {
      kind: 'existing',
      dataLength: 2_000,
      lamports: rentExemptLamports(METADATA_HEADER + 3_000)
    }
  },
  {
    name: 'export: existing metadata shrinks',
    input: { exportOnly: true, metadataBuffer: METADATA_BUFFER },
    metadataBufferData: 1_000,
    metadataPda: { kind: 'existing', dataLength: 2_000, lamports: 1 }
  },
  {
    name: 'create vault transaction: program upgrade only',
    input: {}
  },
  {
    name: 'create vault transaction: anchor IDL + PDA verification, vault 0',
    input: { idlBuffer: IDL_BUFFER, pdaTx: PDA_TX }
  },
  {
    name: 'create vault transaction: existing metadata grows, vault 1',
    input: { metadataBuffer: METADATA_BUFFER, vaultIndex: 1 },
    metadataBufferData: 4_000,
    metadataPda: { kind: 'existing', dataLength: 2_000, lamports: 100 }
  },
  {
    name: 'error: idl-buffer and metadata-buffer together',
    input: { idlBuffer: IDL_BUFFER, metadataBuffer: METADATA_BUFFER }
  },
  {
    name: 'error: keypair missing without export',
    input: { keypair: '' }
  },
  {
    name: 'error: multisig account not owned by Squads',
    input: { multisig: PROGRAM }
  }
]

async function accountsFor(s: Scenario) {
  const accounts: Record<string, FakeAccount> = {
    [PROGRAM]: {
      owner: BPF_LOADER,
      lamports: 1_141_440,
      data: Buffer.alloc(36, 2),
      executable: true
    },
    [BUFFER]: {
      owner: BPF_LOADER,
      lamports: 9_000_000,
      data: Buffer.alloc(64)
    },
    [IDL_BUFFER]: {
      owner: PROGRAM,
      lamports: 2_000_000,
      data: Buffer.alloc(80)
    },
    [MULTISIG]: {
      owner: SQUADS_PROGRAM,
      lamports: 3_000_000,
      data: Buffer.from(squadsGolden.multisigAccount.data, 'hex')
    }
  }
  if (s.metadataBufferData !== undefined) {
    accounts[METADATA_BUFFER] = {
      owner: PROGRAM_METADATA_PROGRAM_ADDRESS,
      lamports: 5_000_000,
      data: Buffer.alloc(METADATA_HEADER + s.metadataBufferData, 1)
    }
  }
  if (s.metadataPda) {
    const [pda] = await findCanonicalPda({
      program: PROGRAM as Address,
      seed: 'idl'
    })
    accounts[pda] =
      s.metadataPda.kind === 'prefund'
        ? {
            owner: SYSTEM_PROGRAM,
            lamports: s.metadataPda.lamports,
            data: Buffer.alloc(0)
          }
        : {
            owner: PROGRAM_METADATA_PROGRAM_ADDRESS,
            lamports: s.metadataPda.lamports,
            data: Buffer.alloc(METADATA_HEADER + s.metadataPda.dataLength, 3)
          }
  }
  return accounts
}

async function run(s: Scenario) {
  const rpc = await startFakeRpc(await accountsFor(s))
  let result: { output?: string; error?: string }
  try {
    const output = await main({
      rpc: rpc.url,
      program: PROGRAM,
      buffer: BUFFER,
      idlBuffer: s.input.idlBuffer ?? '',
      metadataBuffer: s.input.metadataBuffer ?? '',
      multisig: s.input.multisig ?? MULTISIG,
      keypair: s.input.keypair ?? KEYPAIR,
      vaultIndex: s.input.vaultIndex ?? 0,
      priorityFee: 100_000,
      pdaTx: s.input.pdaTx ?? '',
      exportOnly: s.input.exportOnly ?? false,
      exportEncoding: s.input.exportEncoding ?? 'base58'
    })
    result = output === undefined ? {} : { output }
  } catch (error) {
    result = { error: (error as Error).message }
  } finally {
    await rpc.close()
  }
  return { ...result, requests: rpc.requests.map(withoutEmptyConfig) }
}

// An empty trailing config object (`[{}]`) is the same request as no config
// (`[]`); kit sends the former, web3.js sent the latter.
function withoutEmptyConfig(request: RecordedRequest): RecordedRequest {
  const params = request.params as unknown[]
  const last = params[params.length - 1]
  const isEmptyConfig =
    typeof last === 'object' &&
    last !== null &&
    !Array.isArray(last) &&
    Object.keys(last).length === 0
  return isEmptyConfig ? { ...request, params: params.slice(0, -1) } : request
}

describe('main() end to end', () => {
  const recorded: Record<string, unknown> = {}
  const golden: Record<string, unknown> = UPDATE
    ? {}
    : JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'))

  beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {})
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    jest.spyOn(console, 'error').mockImplementation(() => {})
    jest.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`)
    })
  })

  afterAll(() => {
    jest.restoreAllMocks()
    if (UPDATE) {
      writeFileSync(GOLDEN_PATH, JSON.stringify(recorded, null, 2) + '\n')
    }
  })

  it.each(scenarios.map((s) => [s.name, s] as const))(
    '%s',
    async (name, s) => {
      recorded[name] = await run(s)
      expect(recorded[name]).toEqual(UPDATE ? recorded[name] : golden[name])
    },
    20_000
  )
})
