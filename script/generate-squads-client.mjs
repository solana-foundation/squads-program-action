// Generates the Squads v4 multisig client in src/generated/squads from the
// on-chain IDL (idl/squads_multisig_program.json, IDL v2.0.0).
//
// Usage: npm run generate:squads

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  arrayTypeNode,
  bottomUpTransformerVisitor,
  createFromRoot,
  definedTypeNode,
  numberTypeNode,
  prefixedCountNode,
  structFieldTypeNode,
  structTypeNode
} from 'codama'
import { rootNodeFromAnchor } from '@codama/nodes-from-anchor'
import { renderVisitor } from '@codama/renderers-js'

const SQUADS_PROGRAM_ADDRESS = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf'

const idl = JSON.parse(
  readFileSync(
    new URL('../idl/squads_multisig_program.json', import.meta.url),
    'utf8'
  )
)

// The on-chain IDL does not include the program address.
idl.metadata = { ...idl.metadata, address: SQUADS_PROGRAM_ADDRESS }

// The transaction message types use Squads' `SmallVec<L, T>`, a vec with a
// u8/u16 length prefix instead of Borsh's u32. Anchor IDLs can't express that,
// so replace it with a plain vec here and record the prefix size to apply below.
const smallVecPrefixes = new Map()
for (const type of idl.types) {
  for (const field of type.type.fields ?? []) {
    const match = /^SmallVec<(u8|u16),\s*(\w+)>$/.exec(
      field.type?.defined ?? ''
    )
    if (!match) continue
    const [, prefix, item] = match
    const isPrimitive = item === 'u8' || item === 'Pubkey'
    field.type = {
      vec: isPrimitive
        ? item === 'Pubkey'
          ? 'publicKey'
          : item
        : { defined: item }
    }
    smallVecPrefixes.set(`${type.name}.${field.name}`, prefix)
  }
}

const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1)
const prefixedFields = new Map()
for (const [path, prefix] of smallVecPrefixes) {
  const [typeName, fieldName] = path.split('.')
  const key = lowerFirst(typeName)
  if (!prefixedFields.has(key)) prefixedFields.set(key, new Map())
  prefixedFields.get(key).set(fieldName, prefix)
}

const codama = createFromRoot(rootNodeFromAnchor(idl))

codama.update(
  bottomUpTransformerVisitor(
    [...prefixedFields].map(([typeName, fields]) => ({
      select: `[definedTypeNode]${typeName}`,
      transform: (node) =>
        definedTypeNode({
          ...node,
          type: structTypeNode(
            node.type.fields.map((field) => {
              const prefix = fields.get(field.name)
              if (!prefix) return field
              return structFieldTypeNode({
                ...field,
                type: arrayTypeNode(
                  field.type.item,
                  prefixedCountNode(numberTypeNode(prefix))
                )
              })
            })
          )
        })
    }))
  )
)

// renderers-js 1.x generates code for @solana/kit 6, which is the version
// @solana-program/program-metadata uses.
const outDir = new URL('../src/generated/squads', import.meta.url).pathname
await codama.accept(renderVisitor(outDir, { syncPackageJson: false }))

// renderers-js 1.x emits extensionless relative imports, which NodeNext module
// resolution rejects. Point them at the .js file or the folder's index.js.
for (const entry of readdirSync(outDir, { recursive: true })) {
  const file = join(outDir, entry)
  if (!file.endsWith('.ts')) continue
  const source = readFileSync(file, 'utf8')
  const fixed = source.replace(
    /(from\s+["'])(\.\.?(?:\/[^"']*)?)(["'])/g,
    (m, pre, spec, post) => {
      if (spec.endsWith('.js')) return m
      const target = resolve(dirname(file), spec)
      const suffix = existsSync(join(target, 'index.ts')) ? '/index.js' : '.js'
      return `${pre}${spec}${suffix}${post}`
    }
  )
  if (fixed !== source) writeFileSync(file, fixed)
}
