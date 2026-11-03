import { describe, expect, it } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { type Address, type Instruction, AccountRole } from '@solana/kit'
import type { SolanaRpc } from '../src/rpc.js'
import {
  createVaultTransactionCreateInstruction,
  fetchMultisigTransactionIndex,
  getTransactionPda,
  getVaultPda,
  SQUADS_PROGRAM_ID
} from '../src/squads.js'

// Expected values were produced by @sqds/multisig@2.1.4, which this module
// replaces, for the same inputs.
const golden = JSON.parse(
  readFileSync(
    new URL('../__fixtures__/squads-golden.json', import.meta.url),
    'utf8'
  )
)

type IxJson = {
  programId: string
  keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[]
  data: string
}

const ixFromJson = (ix: IxJson): Instruction => ({
  programAddress: ix.programId as Address,
  accounts: ix.keys.map((k) => ({
    address: k.pubkey as Address,
    role: ((k.isSigner ? 2 : 0) | (k.isWritable ? 1 : 0)) as AccountRole
  })),
  data: Buffer.from(ix.data, 'hex')
})

const ixToJson = (ix: Instruction): IxJson => ({
  programId: ix.programAddress,
  keys: (ix.accounts ?? []).map((a) => ({
    pubkey: a.address,
    isSigner: (a.role & 2) !== 0,
    isWritable: (a.role & 1) !== 0
  })),
  data: Buffer.from(ix.data ?? []).toString('hex')
})

const multisigPda = golden.multisigPda as Address

describe('squads.ts', () => {
  for (const c of golden.cases) {
    describe(`vault ${c.vaultIndex}, transaction ${c.transactionIndex}`, () => {
      it('derives the same vault and transaction PDAs as the Squads SDK', async () => {
        expect(await getVaultPda(multisigPda, c.vaultIndex)).toBe(c.vaultPda)
        expect(
          await getTransactionPda(multisigPda, BigInt(c.transactionIndex))
        ).toBe(c.transactionPda)
      })

      it('builds the same vault_transaction_create instruction as the Squads SDK', async () => {
        const ix = await createVaultTransactionCreateInstruction({
          multisigPda,
          transactionIndex: BigInt(c.transactionIndex),
          creator: golden.creator as Address,
          vaultIndex: c.vaultIndex,
          vaultPda: c.vaultPda as Address,
          instructions: c.messageInstructions.map(ixFromJson),
          memo: c.memo ?? undefined
        })
        expect(ixToJson(ix)).toEqual(c.instruction)
      })
    })
  }

  describe('fetchMultisigTransactionIndex', () => {
    const data = Buffer.from(golden.multisigAccount.data, 'hex')
    const rpcWith = (account: { owner: string; data: Buffer } | null) =>
      ({
        getAccountInfo: () => ({
          send: async () => ({
            value: account && {
              owner: account.owner,
              lamports: 1n,
              data: [account.data.toString('base64'), 'base64']
            }
          })
        })
      }) as unknown as SolanaRpc

    it('reads the transaction index from a multisig account', async () => {
      await expect(
        fetchMultisigTransactionIndex(
          rpcWith({ owner: SQUADS_PROGRAM_ID, data }),
          multisigPda
        )
      ).resolves.toBe(BigInt(golden.multisigAccount.transactionIndex))
    })

    it('rejects a missing account', async () => {
      await expect(
        fetchMultisigTransactionIndex(rpcWith(null), multisigPda)
      ).rejects.toThrow('Unable to find Multisig account')
    })

    it('rejects an account owned by another program', async () => {
      await expect(
        fetchMultisigTransactionIndex(
          rpcWith({ owner: '11111111111111111111111111111111', data }),
          multisigPda
        )
      ).rejects.toThrow('not owned by the Squads program')
    })

    it('rejects a Squads account that is not a multisig', async () => {
      const wrong = Buffer.from(data)
      wrong[0] ^= 0xff
      await expect(
        fetchMultisigTransactionIndex(
          rpcWith({ owner: SQUADS_PROGRAM_ID, data: wrong }),
          multisigPda
        )
      ).rejects.toThrow('not a Squads multisig')
    })
  })
})
