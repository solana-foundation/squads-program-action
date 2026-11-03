# Squads Program Action

A GitHub Action to automate Solana program upgrades through Squads multisig.
This action creates and submits a multisig transaction that includes program
upgrade, optional IDL update, and optional PDA verification.

The easiest way to use this squads action is to use the
[reusable workflow](https://github.com/solana-developers/github-workflows) which
will automatically handle the build, upload, and verify steps.

## Features

- Creates a Squads multisig transaction containing:
  - Program upgrade instruction using a new buffer
  - Anchor IDL upgrade instruction using an IDL buffer
  - Program-metadata IDL update using a metadata buffer (alternative to Anchor
    IDL, works with any program)
  - Optional PDA verification instruction
- Handles automatic retries for RPC connections
- Supports custom RPC endpoints
- Works with any Squads v4 multisig

## Usage

```yaml
- uses: Woody4618/squads-program-action@v0.4.0
  with:
    # Required: RPC URL for Solana
    rpc: ${{ secrets.RPC_URL }}

    # Required: Program ID to upgrade
    program: BhV84MZrRnEvtWLdWMRJGJr1GbusxfVMHAwc3pq92g4z

    # Required: Buffer containing the new program
    buffer: 7SGJSG8aoZj39NeAkZvbUvsPDMRcUUrhRhPzgzKv7743

    # Optional: Buffer containing the new Anchor IDL
    idl-buffer: E74BKk75nHtSScZJ4YZ5gB2orvhdzLjcFyxyqkNx6MNc

    # Optional: Buffer containing the new IDL via program-metadata (alternative to idl-buffer)
    # metadata-buffer: <address from write-metadata-buffer action>

    # Required: Squads multisig address
    multisig: ${{ secrets.MULTISIG }}

    # Required: Byte array of the keypair. Needs to have proposer permission in squads. Format: [23,42,53...]
    keypair: ${{ secrets.KEYPAIR }}

    # Optional: Priority fee in lamports for the transaction (default: 100000)
    priority-fee: 100000

    # Optional: Index of the Squads vault to use (default: 0)
    vault-index: 0

    # Optional: Base58 or base64 encoded PDA verification transaction. Get this from solana verify cli using solana-verify export-pda-tx
    pda-tx: ${{ secrets.PDA_TX }}
```

## Prerequisites

Before using this action, you need:

1. A Squads v4 multisig with:
   - Program upgrade authority
   - Required members set up
2. Program buffer uploaded to Solana
3. IDL buffer uploaded to Solana (either Anchor IDL or program-metadata buffer)
4. Keypair with permission to create transactions in the multisig

> **Note:** Both `idl-buffer` (Anchor) and `metadata-buffer` (program-metadata)
> assume the IDL/metadata account has already been initialized. The initial
> setup is typically done during the first deploy before transferring authority
> to the multisig.

## Example Workflow (Anchor IDL)

```yaml
name: Upgrade Program
on:
  workflow_dispatch:
    inputs:
      buffer:
        description: 'Program buffer address'
        required: true
      idl-buffer:
        description: 'IDL buffer address'
        required: true

jobs:
  upgrade:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Woody4618/squads-program-action@v0.4.0
        with:
          rpc: ${{ secrets.RPC_URL }}
          program: BhV84MZrRnEvtWLdWMRJGJr1GbusxfVMHAwc3pq92g4z
          buffer: ${{ inputs.buffer }}
          idl-buffer: ${{ inputs.idl-buffer }}
          multisig: ${{ secrets.MULTISIG }}
          keypair: ${{ secrets.KEYPAIR }}
          priority-fee: 200000
          vault-index: 0
```

## Example Workflow (Program Metadata IDL)

Use this approach for non-Anchor programs or as a modern alternative to Anchor
IDL. Requires the
[write-metadata-buffer](https://github.com/solana-developers/github-actions)
action to create the buffer first.

```yaml
name: Upgrade Program
on:
  workflow_dispatch:
    inputs:
      buffer:
        description: 'Program buffer address'
        required: true

jobs:
  upgrade:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: solana-developers/github-actions/write-metadata-buffer@pmp-upload
        id: metadata-buffer
        with:
          idl-path: ./target/idl/my_program.json
          rpc-url: ${{ secrets.RPC_URL }}
          keypair: ${{ secrets.DEPLOYER_KEYPAIR }}
          buffer-authority: ${{ secrets.SQUADS_VAULT }}

      - uses: Woody4618/squads-program-action@v0.4.0
        with:
          rpc: ${{ secrets.RPC_URL }}
          program: BhV84MZrRnEvtWLdWMRJGJr1GbusxfVMHAwc3pq92g4z
          buffer: ${{ inputs.buffer }}
          metadata-buffer: ${{ steps.metadata-buffer.outputs.buffer }}
          multisig: ${{ secrets.MULTISIG }}
          keypair: ${{ secrets.KEYPAIR }}
          priority-fee: 200000
          vault-index: 0
```

## Example Workflow (Export Only, No Squads Membership)

Set `export: 'true'` to output the combined transaction instead of creating the
Squads vault transaction. No keypair or Squads membership is required. A
multisig member imports the output into the
[Squads transaction builder](https://v4.squads.so/) to create the proposal — one
import, one approval.

```yaml
- uses: solana-foundation/squads-program-action@v0.5.2
  id: export-squads-tx
  with:
    rpc: ${{ secrets.RPC_URL }}
    program: BhV84MZrRnEvtWLdWMRJGJr1GbusxfVMHAwc3pq92g4z
    buffer: ${{ inputs.buffer }}
    metadata-buffer: ${{ steps.metadata-buffer.outputs.buffer }}
    multisig: ${{ secrets.MULTISIG }}
    export: 'true'
    export-encoding: base58

- run: echo "${{ steps.export-squads-tx.outputs.tx }}"
```

The export contains all instructions (program upgrade, IDL update, PDA
verification) in one transaction. If they exceed the 1232 byte transaction size
limit, the action fails instead of exporting a partial transaction.

## What Happens After Running

1. The action creates a transaction in your Squads multisig containing:
   - Program upgrade instruction
   - IDL upgrade instruction
   - PDA verification (if provided)
2. Visit [Squads UI](https://v4.squads.so/) to:
   - Review the transaction
   - Approve with required signatures
3. Once enough members approve, Squads executes:
   - Program upgrade
   - IDL update (if included)
   - PDA verification (if included)

## Security Notes

- The provided keypair only needs permission to create transactions
- Actual upgrade authority comes from the Squads vault
- Keep your keypair and multisig address secure in GitHub Secrets
- Use a reliable RPC endpoint as the action includes retry logic

## Development Guide

To contribute or modify this action:

1. Clone the repository
2. Install dependencies:

```bash
npm install
```

3. Make your changes
4. Build the action:

```bash
npm run bundle
```

5. Test locally:

```bash
npm run local-action
```

## Create a GitHub Action Using TypeScript

[![GitHub Super-Linter](https://github.com/actions/typescript-action/actions/workflows/linter.yml/badge.svg)](https://github.com/super-linter/super-linter)
![CI](https://github.com/actions/typescript-action/actions/workflows/ci.yml/badge.svg)
[![Check dist/](https://github.com/actions/typescript-action/actions/workflows/check-dist.yml/badge.svg)](https://github.com/actions/typescript-action/actions/workflows/check-dist.yml)
[![CodeQL](https://github.com/actions/typescript-action/actions/workflows/codeql-analysis.yml/badge.svg)](https://github.com/actions/typescript-action/actions/workflows/codeql-analysis.yml)
[![Coverage](./badges/coverage.svg)](./badges/coverage.svg)

Use this template to bootstrap the creation of a TypeScript action. :rocket:

This template includes compilation support, tests, a validation workflow,
publishing, and versioning guidance.

If you are new, there's also a simpler introduction in the
[Hello world JavaScript action repository](https://github.com/actions/hello-world-javascript-action).

## Create Your Own Action

To create your own action, you can use this repository as a template! Just
follow the below instructions:

1. Click the **Use this template** button at the top of the repository
1. Select **Create a new repository**
1. Select an owner and name for your new repository
1. Click **Create repository**
1. Clone your new repository

> [!IMPORTANT]
>
> Make sure to remove or update the [`CODEOWNERS`](./CODEOWNERS) file! For
> details on how to use this file, see
> [About code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners).

## Initial Setup

After you've cloned the repository to your local machine or codespace, you'll
need to perform some initial setup steps before you can develop your action.

> [!NOTE]
>
> You'll need to have a reasonably modern version of
> [Node.js](https://nodejs.org) handy (20.x or later should work!). If you are
> using a version manager like [`nodenv`](https://github.com/nodenv/nodenv) or
> [`fnm`](https://github.com/Schniz/fnm), this template has a `.node-version`
> file at the root of the repository that can be used to automatically switch to
> the correct version when you `cd` into the repository. Additionally, this
> `.node-version` file is used by GitHub Actions in any `actions/setup-node`
> actions.

1. :hammer_and_wrench: Install the dependencies

   ```bash
   npm install
   ```

1. :building_construction: Package the TypeScript for distribution

   ```bash
   npm run bundle
   ```

1. :white_check_mark: Run the tests

   ```bash
   $ npm test

   PASS  ./index.test.js
     ✓ throws invalid number (3ms)
     ✓ wait 500 ms (504ms)
     ✓ test runs (95ms)

   ...
   ```

## Update the Action Metadata

The [`action.yml`](action.yml) file defines metadata about your action, such as
input(s) and output(s). For details about this file, see
[Metadata syntax for GitHub Actions](https://docs.github.com/en/actions/creating-actions/metadata-syntax-for-github-actions).

When you copy this repository, update `action.yml` with the name, description,
inputs, and outputs for your action.

## Update the Action Code

The [`src/`](./src/) directory is the heart of your action! This contains the
source code that will be run when your action is invoked. You can replace the
contents of this directory with your own code.

There are a few things to keep in mind when writing your action code:

- Most GitHub Actions toolkit and CI/CD operations are processed asynchronously.
  In `main.ts`, you will see that the action is run in an `async` function.

  ```javascript
  import * as core from '@actions/core'
  //...

  async function run() {
    try {
      //...
    } catch (error) {
      core.setFailed(error.message)
    }
  }
  ```

  For more information about the GitHub Actions toolkit, see the
  [documentation](https://github.com/actions/toolkit/blob/master/README.md).

So, what are you waiting for? Go ahead and start customizing your action!

1. Create a new branch

   ```bash
   git checkout -b releases/v1
   ```

1. Replace the contents of `src/` with your action code
1. Add tests to `__tests__/` for your source code
1. Format, test, and build the action

   ```bash
   npm run all
   ```

   > This step is important! It will run [`rollup`](https://rollupjs.org/) to
   > build the final JavaScript action code with all dependencies included. If
   > you do not run this step, your action will not work correctly when it is
   > used in a workflow.

1. (Optional) Test your action locally

   The [`@github/local-action`](https://github.com/github/local-action) utility
   can be used to test your action locally. It is a simple command-line tool
   that "stubs" (or simulates) the GitHub Actions Toolkit. This way, you can run
   your TypeScript action locally without having to commit and push your changes
   to a repository.

   The `local-action` utility can be run in the following ways:

   - Visual Studio Code Debugger

     Make sure to review and, if needed, update
     [`.vscode/launch.json`](./.vscode/launch.json)

   - Terminal/Command Prompt

     ```bash
     # npx local action <action-yaml-path> <entrypoint> <dotenv-file>
     npx local-action . src/main.ts .env
     ```

   You can provide a `.env` file to the `local-action` CLI to set environment
   variables used by the GitHub Actions Toolkit. For example, setting inputs and
   event payload data used by your action. For more information, see the example
   file, [`.env.example`](./.env.example), and the
   [GitHub Actions Documentation](https://docs.github.com/en/actions/learn-github-actions/variables#default-environment-variables).

1. Commit your changes

   ```bash
   git add .
   git commit -m "My first action is ready!"
   ```

1. Push them to your repository

   ```bash
   git push -u origin releases/v1
   ```

1. Create a pull request and get feedback on your action
1. Merge the pull request into the `main` branch

Your action is now published! :rocket:

For information about versioning your action, see
[Versioning](https://github.com/actions/toolkit/blob/master/docs/action-versioning.md)
in the GitHub Actions toolkit.

## Local Development

After testing, you can create version tag(s) that developers can use to
reference different stable versions of your action.

To include the action in a workflow in another repository, you can use the
`uses` syntax with the `@` symbol to reference a specific branch, tag, or commit
hash.

```yaml
steps:
  - name: Checkout
    id: checkout
    uses: actions/checkout@v4

  - name: Test Local Action
    id: test-action
    uses: actions/typescript-action@v1 # Commit with the `v1` tag
    with:
      milliseconds: 1000

  - name: Print Output
    id: output
    run: echo "${{ steps.test-action.outputs.time }}"
```

## Publishing a New Release

This project includes a helper script, [`script/release`](./script/release)
designed to streamline the process of tagging and pushing new releases for
GitHub Actions.

GitHub Actions allows users to select a specific version of the action to use,
based on release tags. This script simplifies this process by performing the
following steps:

1. **Retrieving the latest release tag:** The script starts by fetching the most
   recent SemVer release tag of the current branch, by looking at the local data
   available in your repository.
1. **Prompting for a new release tag:** The user is then prompted to enter a new
   release tag. To assist with this, the script displays the tag retrieved in
   the previous step, and validates the format of the inputted tag (vX.X.X). The
   user is also reminded to update the version field in package.json.
1. **Tagging the new release:** The script then tags a new release and syncs the
   separate major tag (e.g. v1, v2) with the new release tag (e.g. v1.0.0,
   v2.1.2). When the user is creating a new major release, the script
   auto-detects this and creates a `releases/v#` branch for the previous major
   version.
1. **Pushing changes to remote:** Finally, the script pushes the necessary
   commits, tags and branches to the remote repository. From here, you will need
   to create a new release in GitHub so users can easily reference the new tags
   in their workflows.
