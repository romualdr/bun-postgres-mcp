import { describe, expect, test } from 'bun:test'
import { MockDriver, cells } from './mock-driver'
import { run } from '../src/commands/list_schemas'

describe('run', () => {
  test('returns JSON array of schema rows', async () => {
    const driver = new MockDriver([
      cells([
        { schema_name: 'public', schema_owner: 'postgres', schema_type: 'User Schema' },
        { schema_name: 'information_schema', schema_owner: 'postgres', schema_type: 'System Information Schema' },
      ]),
    ])
    const result = JSON.parse(await run(driver))
    expect(result).toHaveLength(2)
    expect(result[0].schema_name).toBe('public')
    expect(result[1].schema_type).toBe('System Information Schema')
  })

  test('returns empty array when no schemas found', async () => {
    const driver = new MockDriver([null])
    const result = JSON.parse(await run(driver))
    expect(result).toEqual([])
  })
})
