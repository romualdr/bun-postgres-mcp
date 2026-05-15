import type { McpServer } from '@modelcontextprotocol/server'
import z from 'zod'
import type { Arguments } from '../constants'
import { error, textResult } from '../lib/utils'
import type { SQL } from '../sql'
import type { Driver } from '../sql/driver'

export async function run(
  driver: Driver,
  schema_name: string,
  object_name: string,
  object_type: 'table' | 'view' | 'sequence' | 'extension',
): Promise<string> {
  if (object_type === 'table' || object_type === 'view') {
    const colRows = await driver.executeParamQuery(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
      [schema_name, object_name],
    )

    const columns =
      colRows?.map((r) => ({
        column: r.cells['column_name'],
        data_type: r.cells['data_type'],
        is_nullable: r.cells['is_nullable'],
        default: r.cells['column_default'],
      })) ?? []

    const conRows = await driver.executeParamQuery(
      `SELECT tc.constraint_name, tc.constraint_type, kcu.column_name
         FROM information_schema.table_constraints AS tc
         LEFT JOIN information_schema.key_column_usage AS kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
         WHERE tc.table_schema = $1 AND tc.table_name = $2`,
      [schema_name, object_name],
    )

    const constraintMap = new Map<string, { type: string; columns: string[] }>()
    for (const row of conRows ?? []) {
      const name = row.cells['constraint_name'] as string
      const type = row.cells['constraint_type'] as string
      const col = row.cells['column_name'] as string | null
      if (!constraintMap.has(name))
        constraintMap.set(name, { type, columns: [] })
      if (col) constraintMap.get(name)!.columns.push(col)
    }
    const constraints = Array.from(constraintMap.entries()).map(
      ([name, data]) => ({ name, ...data }),
    )

    const idxRows = await driver.executeParamQuery(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2`,
      [schema_name, object_name],
    )
    const indexes =
      idxRows?.map((r) => ({
        name: r.cells['indexname'],
        definition: r.cells['indexdef'],
      })) ?? []

    return JSON.stringify({
      basic: { schema: schema_name, name: object_name, type: object_type },
      columns,
      constraints,
      indexes,
    })
  }

  if (object_type === 'sequence') {
    const rows = await driver.executeParamQuery(
      `SELECT sequence_schema, sequence_name, data_type, start_value, increment
         FROM information_schema.sequences
         WHERE sequence_schema = $1 AND sequence_name = $2`,
      [schema_name, object_name],
    )
    if (!rows || rows.length === 0) return JSON.stringify({})
    const r = rows[0]?.cells
    return JSON.stringify({
      schema: r?.['sequence_schema'],
      name: r?.['sequence_name'],
      data_type: r?.['data_type'],
      start_value: r?.['start_value'],
      increment: r?.['increment'],
    })
  }

  if (object_type === 'extension') {
    const rows = await driver.executeParamQuery(
      `SELECT extname, extversion, extrelocatable FROM pg_extension WHERE extname = $1`,
      [object_name],
    )
    if (!rows || rows.length === 0) return JSON.stringify({})
    const r = rows[0]?.cells
    return JSON.stringify({
      name: r?.['extname'],
      version: r?.['extversion'],
      relocatable: r?.['extrelocatable'],
    })
  }

  return error(`Unsupported object type: ${object_type}`)
}

export const register = async (
  _parameters: Arguments,
  mcp: McpServer,
  sql: SQL,
) => {
  mcp.registerTool(
    'get_object_details',
    {
      description: 'Show detailed information about a database object',
      inputSchema: z.object({
        schema_name: z.string().describe('Schema name'),
        object_name: z.string().describe('Object name'),
        object_type: z
          .enum(['table', 'view', 'sequence', 'extension'])
          .default('table')
          .describe('Object type'),
      }),
      annotations: { title: 'Get Object Details', readOnlyHint: true },
    },
    async ({ schema_name, object_name, object_type }) =>
      textResult(await run(sql.client, schema_name, object_name, object_type)),
  )
}
