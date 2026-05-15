import type { McpServer } from '@modelcontextprotocol/server'
import z from 'zod'
import type { Arguments } from '../constants'
import { anonymizeRows } from '../lib/anonymization'
import { rewriteForAnonymization } from '../lib/query-rewriter'
import { textResult } from '../lib/utils'
import type { SQL } from '../sql'
import type { Driver } from '../sql/driver'

export async function run(
  driver: Driver,
  query: string,
  anonymize: boolean,
): Promise<string> {
  if (anonymize) query = await rewriteForAnonymization(driver, query)
  const rows = await driver.executeQuery(query)
  if (rows === null) return 'No results'
  const cells = rows.map((r) => r.cells)
  return JSON.stringify(anonymize ? anonymizeRows(cells) : cells)
}

export const register = async (
  parameters: Arguments,
  mcp: McpServer,
  sql: SQL,
) => {
  const { anonymize } = parameters

  mcp.registerTool(
    'execute_sql',
    {
      description: parameters.restricted
        ? `Execute a read-only SQL query${anonymize ? ' (sensitive fields are redacted)' : ''}`
        : `Execute any SQL query${anonymize ? ' (sensitive fields are redacted)' : ''}`,
      inputSchema: z.object({
        sql: z.string().describe('SQL to execute'),
      }),
      annotations: parameters.restricted
        ? { title: 'Execute SQL (Read-Only)', readOnlyHint: true }
        : { title: 'Execute SQL', destructiveHint: true },
    },
    async ({ sql: querySql }) =>
      textResult(await run(sql.client, querySql, anonymize)),
  )
}
