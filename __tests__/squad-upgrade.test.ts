import { describe, expect, it } from '@jest/globals'
import { randomBytes } from 'node:crypto'
import {
  type Address,
  type Instruction,
  AccountRole,
  createNoopSigner,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder
} from '@solana/kit'
import {
  getTransferSolInstruction,
  SYSTEM_PROGRAM_ADDRESS
} from '@solana-program/system'
import bs58 from 'bs58'
import { compileMessage, serializeTransaction } from '../src/compile.js'
import {
  buildExportTransaction,
  parseVerificationTransaction
} from '../src/squad-upgrade.js'

const randomAddress = () => bs58.encode(randomBytes(32)) as Address

const transfer = (from: Address): Instruction =>
  getTransferSolInstruction({
    source: createNoopSigner(from),
    destination: randomAddress(),
    amount: 1n
  })

function createWireTransaction(): Buffer {
  const payer = randomAddress()
  return Buffer.from(
    serializeTransaction(
      compileMessage('legacy', payer, randomAddress(), [transfer(payer)])
    )
  )
}

function decodeLegacyTransaction(wire: Buffer) {
  const { messageBytes } = getTransactionDecoder().decode(wire)
  const message = getCompiledTransactionMessageDecoder().decode(messageBytes)
  if (message.version !== 'legacy') throw new Error('expected legacy message')
  return message
}

describe('parseVerificationTransaction', () => {
  it.each([
    ['base64', (bytes: Buffer) => bytes.toString('base64')],
    ['base58', (bytes: Buffer) => bs58.encode(bytes)]
  ])('parses a %s encoded transaction', async (_encoding, encode) => {
    const encoded = encode(createWireTransaction())

    const transaction = await parseVerificationTransaction(encoded)

    expect(transaction.instructions).toHaveLength(1)
    expect(transaction.instructions[0].programAddress).toEqual(
      SYSTEM_PROGRAM_ADDRESS
    )
  })

  it('rejects invalid transaction data with a useful error', async () => {
    await expect(
      parseVerificationTransaction('not-a-transaction')
    ).rejects.toThrow(
      'Unable to decode PDA verification transaction as base64 or base58'
    )
  })
})

describe('buildExportTransaction', () => {
  const feePayer = randomAddress()
  const recentBlockhash = randomAddress()

  function createInstructions(count: number): Instruction[] {
    return Array.from({ length: count }, () => transfer(feePayer))
  }

  it.each([
    ['base58', (encoded: string) => Buffer.from(bs58.decode(encoded))],
    ['base64', (encoded: string) => Buffer.from(encoded, 'base64')]
  ])(
    'exports all instructions in one %s encoded transaction',
    (encoding, decode) => {
      const instructions = createInstructions(3)

      const encoded = buildExportTransaction(
        instructions,
        feePayer,
        recentBlockhash,
        encoding as 'base58' | 'base64'
      )

      const message = decodeLegacyTransaction(decode(encoded))
      expect(message.instructions).toHaveLength(3)
      expect(message.staticAccounts[0]).toEqual(feePayer)
      expect(message.lifetimeToken).toEqual(recentBlockhash)
      expect(
        message.instructions.every(
          (ix) =>
            message.staticAccounts[ix.programAddressIndex] ===
            SYSTEM_PROGRAM_ADDRESS
        )
      ).toBe(true)
    }
  )

  it('defaults to base58 encoding', () => {
    const encoded = buildExportTransaction(
      createInstructions(1),
      feePayer,
      recentBlockhash
    )

    const message = decodeLegacyTransaction(Buffer.from(bs58.decode(encoded)))
    expect(message.instructions).toHaveLength(1)
  })

  it('rejects transactions above the size limit with a useful error', () => {
    const oversized: Instruction = {
      programAddress: SYSTEM_PROGRAM_ADDRESS,
      accounts: [{ address: feePayer, role: AccountRole.WRITABLE }],
      data: new Uint8Array(1300)
    }

    expect(() =>
      buildExportTransaction([oversized], feePayer, recentBlockhash)
    ).toThrow('exceeds the 1232 byte transaction limit')
  })
})
