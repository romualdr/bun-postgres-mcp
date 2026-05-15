# Contributing

## Prerequisites

- [Bun](https://bun.sh) >= 1.3

## Setup

```sh
bun install
```

## Development

Run directly from source (no build step needed):

```sh
DATABASE_URL=postgres://user:pass@localhost:5432/mydb bun index.ts
```

Or with options:

```sh
bun index.ts --anonymize postgres://user:pass@localhost:5432/mydb
```

## Build

The build step bundles everything into a single `dist/index.js` with a shebang, ready to be run as a CLI binary:

```sh
bun run build
```

Output: `dist/index.js`

The build script (`scripts/build.ts`) uses `bun build` with `--target bun` and injects a `#!/usr/bin/env bun` shebang if missing.

## Tests

```sh
bun test
```

Tests live in `tests/`. They require a running Postgres instance — set `DATABASE_URL` before running.

## Project structure

```
index.ts              # Entrypoint — calls src/mcp.ts run()
src/
  mcp.ts              # MCP server setup, CLI arg parsing, DB connection
  constants.ts        # Shared types and enums (AccessMode, RegisterCommand, etc.)
  commands/           # One file per MCP tool — each exports a register() function
  lib/                # Shared utilities (logger, arg parser, anonymizer, etc.)
  sql/                # Database driver wrapper (Bun.sql) and query helpers
scripts/
  build.ts            # Build script
tests/                # Test files
docs/
  anonymization_report.md  # Security analysis of the anonymization layer
```

## Adding a new MCP tool

Each file in `src/commands/` exports a single `register` function matching the `RegisterCommand` type from `src/constants.ts`. The MCP server auto-discovers and loads all files in that directory at startup.

```ts
// src/commands/my_tool.ts
import type { RegisterCommand } from '../constants'

export const register: RegisterCommand = (args, mcp, sql) => {
  mcp.tool('my_tool', 'Description shown to the AI', { /* zod schema */ }, async (params) => {
    // implement tool
  })
}
```

## Publishing

The package ships only the `dist/` directory (see `files` in `package.json`). Build before publishing:

```sh
bun run build
npm publish   # or: bunx npm publish
```

The `bin` entry in `package.json` maps `bun-postgres-mcp` → `dist/index.js`, which is what `bunx bun-postgres-mcp` resolves to.
