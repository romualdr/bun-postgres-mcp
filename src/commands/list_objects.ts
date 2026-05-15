import type { McpServer } from '@modelcontextprotocol/server'
import z from 'zod'
import type { Arguments } from '../constants'
import { error, textResult } from '../lib/utils'
import type { SQL } from '../sql'
import type { Driver } from '../sql/driver'

export async function run(
  driver: Driver,
  schema_name: string,
  object_type: 'table' | 'view' | 'sequence' | 'extension',
): Promise<string> {
  if (object_type === 'table' || object_type === 'view') {
    const tableType = object_type === 'table' ? 'BASE TABLE' : 'VIEW'
    const rows = await driver.executeParamQuery(
      `SELECT table_schema, table_name, table_type
         FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = $2
         ORDER BY table_name`,
      [schema_name, tableType],
    )
    const objects =
      rows?.map((r) => ({
        schema: r.cells['table_schema'],
        name: r.cells['table_name'],
        type: r.cells['table_type'],
      })) ?? []
    return JSON.stringify(objects)
  }

  if (object_type === 'sequence') {
    const rows = await driver.executeParamQuery(
      `SELECT sequence_schema, sequence_name, data_type
         FROM information_schema.sequences
         WHERE sequence_schema = $1
         ORDER BY sequence_name`,
      [schema_name],
    )
    const objects =
      rows?.map((r) => ({
        schema: r.cells['sequence_schema'],
        name: r.cells['sequence_name'],
        data_type: r.cells['data_type'],
      })) ?? []
    return JSON.stringify(objects)
  }

  if (object_type === 'extension') {
    const rows = await driver.executeQuery(
      `SELECT extname, extversion, extrelocatable FROM pg_extension ORDER BY extname`,
    )
    const objects =
      rows?.map((r) => ({
        name: r.cells['extname'],
        version: r.cells['extversion'],
        relocatable: r.cells['extrelocatable'],
      })) ?? []
    return JSON.stringify(objects)
  }

  return error(`Unsupported object type: ${object_type}`)
}

export const register = async (
  _parameters: Arguments,
  mcp: McpServer,
  sql: SQL,
) => {
  mcp.registerTool(
    'list_objects',
    {
      description: 'List objects in a schema',
      inputSchema: z.object({
        schema_name: z.string().describe('Schema name'),
        object_type: z
          .enum(['table', 'view', 'sequence', 'extension'])
          .default('table')
          .describe('Object type'),
      }),
      annotations: { title: 'List Objects', readOnlyHint: true },
    },
    async ({ schema_name, object_type }) =>
      textResult(await run(sql.client, schema_name, object_type)),
  )
}
