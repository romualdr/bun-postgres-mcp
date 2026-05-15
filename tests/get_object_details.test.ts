import { describe, expect, test } from 'bun:test'
import { MockDriver, cells } from './mock-driver'
import { run } from '../src/commands/get_object_details'

describe('run — table', () => {
  test('returns columns, constraints, and indexes', async () => {
    const driver = new MockDriver([
      // columns
      cells([{ column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null }]),
      // constraints
      cells([{ constraint_name: 'users_pkey', constraint_type: 'PRIMARY KEY', column_name: 'id' }]),
      // indexes
      cells([{ indexname: 'users_pkey', indexdef: 'CREATE UNIQUE INDEX users_pkey ON users USING btree (id)' }]),
    ])
    const result = JSON.parse(await run(driver, 'public', 'users', 'table'))
    expect(result.basic).toEqual({ schema: 'public', name: 'users', type: 'table' })
    expect(result.columns).toHaveLength(1)
    expect(result.columns[0].column).toBe('id')
    expect(result.constraints).toHaveLength(1)
    expect(result.constraints[0].name).toBe('users_pkey')
    expect(result.constraints[0].columns).toEqual(['id'])
    expect(result.indexes).toHaveLength(1)
  })

  test('groups multiple constraint rows by constraint name', async () => {
    const driver = new MockDriver([
      cells([
        { column_name: 'a', data_type: 'int', is_nullable: 'NO', column_default: null },
        { column_name: 'b', data_type: 'int', is_nullable: 'NO', column_default: null },
      ]),
      cells([
        { constraint_name: 'uq_ab', constraint_type: 'UNIQUE', column_name: 'a' },
        { constraint_name: 'uq_ab', constraint_type: 'UNIQUE', column_name: 'b' },
      ]),
      cells([]),
    ])
    const result = JSON.parse(await run(driver, 'public', 't', 'table'))
    expect(result.constraints).toHaveLength(1)
    expect(result.constraints[0].columns).toEqual(['a', 'b'])
  })
})

describe('run — sequence', () => {
  test('returns sequence details', async () => {
    const driver = new MockDriver([
      cells([{
        sequence_schema: 'public',
        sequence_name: 'users_id_seq',
        data_type: 'bigint',
        start_value: '1',
        increment: '1',
      }]),
    ])
    const result = JSON.parse(await run(driver, 'public', 'users_id_seq', 'sequence'))
    expect(result.name).toBe('users_id_seq')
    expect(result.data_type).toBe('bigint')
  })

  test('returns {} when sequence not found', async () => {
    const driver = new MockDriver([null])
    expect(await run(driver, 'public', 'missing_seq', 'sequence')).toBe('{}')
  })
})

describe('run — extension', () => {
  test('returns extension details', async () => {
    const driver = new MockDriver([
      cells([{ extname: 'uuid-ossp', extversion: '1.1', extrelocatable: true }]),
    ])
    const result = JSON.parse(await run(driver, 'public', 'uuid-ossp', 'extension'))
    expect(result.name).toBe('uuid-ossp')
    expect(result.version).toBe('1.1')
  })

  test('returns {} when extension not found', async () => {
    const driver = new MockDriver([null])
    expect(await run(driver, 'public', 'missing', 'extension')).toBe('{}')
  })
})
