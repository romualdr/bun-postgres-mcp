import type { McpServer } from '@modelcontextprotocol/server'
import type { Arguments } from '../constants'
import { textResult } from '../lib/utils'
import type { SQL } from '../sql'
import type { Driver } from '../sql/driver'

export async function run(driver: Driver): Promise<string> {
  const rows = await driver.executeQuery(`
      SELECT
        schema_name,
        schema_owner,
        CASE
          WHEN schema_name LIKE 'pg_%' THEN 'System Schema'
          WHEN schema_name = 'information_schema' THEN 'System Information Schema'
          ELSE 'User Schema'
        END AS schema_type
      FROM information_schema.schemata
      ORDER BY schema_type, schema_name
    `)
  return JSON.stringify(rows?.map((r) => r.cells) ?? [])
}

export const register = async (
  _parameters: Arguments,
  mcp: McpServer,
  sql: SQL,
) => {
  mcp.registerTool(
    'list_schemas',
    {
      description: 'List all schemas in the database',
      annotations: { title: 'List Schemas', readOnlyHint: true },
    },
    async () => textResult(await run(sql.client)),
  )
}
