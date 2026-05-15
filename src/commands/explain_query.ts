import type { McpServer } from '@modelcontextprotocol/server'
import z from 'zod'
import type { Arguments } from '../constants'
import { textResult } from '../lib/utils'
import type { SQL } from '../sql'
import type { Driver } from '../sql/driver'

export async function run(
  driver: Driver,
  querySql: string,
  analyze: boolean,
): Promise<string> {
  const explainSql = analyze
    ? `EXPLAIN (ANALYZE, FORMAT JSON) ${querySql}`
    : `EXPLAIN (FORMAT JSON) ${querySql}`
  const rows = await driver.executeQuery(explainSql)
  return JSON.stringify(rows?.[0]?.cells ?? {})
}

export const register = async (
  _parameters: Arguments,
  mcp: McpServer,
  sql: SQL,
) => {
  mcp.registerTool(
    'explain_query',
    {
      description:
        'Explains the execution plan for a SQL query, showing how the database will execute it and provides detailed cost estimates.',
      inputSchema: z.object({
        sql: z.string().describe('SQL query to explain'),
        analyze: z
          .boolean()
          .default(false)
          .describe(
            'When true, actually runs the query to show real execution statistics instead of estimates. Takes longer but provides more accurate information.',
          ),
      }),
      annotations: { title: 'Explain Query', readOnlyHint: true },
    },
    async ({ sql: querySql, analyze }) =>
      textResult(await run(sql.client, querySql, analyze)),
  )
}
