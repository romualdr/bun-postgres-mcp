import type { McpServer } from '@modelcontextprotocol/server'
import type { get_parameters } from './lib/args'
import type { SQL } from './sql'

export const USAGE = `
Usage: bun-postgres-mcp [options] [DATABASE_URL]

Options:
  --mode [restricted|unrestricted]   Set the access mode (default: restricted)
  --anonymize                        Redact sensitive fields in execute_sql results

DATABASE_URL can also be provided via the DATABASE_URL environment variable.
`

export type Arguments = ReturnType<typeof get_parameters>

export type RegisterCommand = (
  parameters: Arguments,
  mcp: McpServer,
  sql: SQL,
) => Promise<void>

export enum AccessMode {
  UNRESTRICTED = 'unrestricted',
  RESTRICTED = 'restricted',
}
