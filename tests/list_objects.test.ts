import { describe, expect, test } from 'bun:test'
import { MockDriver, cells } from './mock-driver'
import { run } from '../src/commands/list_objects'

describe('run — table', () => {
  test('returns mapped table objects', async () => {
    const driver = new MockDriver([
      cells([
        { table_schema: 'public', table_name: 'users', table_type: 'BASE TABLE' },
      ]),
    ])
    const result = JSON.parse(await run(driver, 'public', 'table'))
    expect(result).toEqual([{ schema: 'public', name: 'users', type: 'BASE TABLE' }])
  })

  test('returns empty array when no tables', async () => {
    const driver = new MockDriver([null])
    expect(JSON.parse(await run(driver, 'public', 'table'))).toEqual([])
  })
})

describe('run — view', () => {
  test('returns mapped view objects', async () => {
    const driver = new MockDriver([
      cells([{ table_schema: 'public', table_name: 'user_view', table_type: 'VIEW' }]),
    ])
    const result = JSON.parse(await run(driver, 'public', 'view'))
    expect(result[0].type).toBe('VIEW')
  })
})

describe('run — sequence', () => {
  test('returns mapped sequence objects', async () => {
    const driver = new MockDriver([
      cells([{ sequence_schema: 'public', sequence_name: 'users_id_seq', data_type: 'bigint' }]),
    ])
    const result = JSON.parse(await run(driver, 'public', 'sequence'))
    expect(result[0]).toEqual({ schema: 'public', name: 'users_id_seq', data_type: 'bigint' })
  })
})

describe('run — extension', () => {
  test('returns mapped extension objects', async () => {
    const driver = new MockDriver([
      cells([{ extname: 'pg_stat_statements', extversion: '1.9', extrelocatable: true }]),
    ])
    const result = JSON.parse(await run(driver, 'public', 'extension'))
    expect(result[0]).toEqual({ name: 'pg_stat_statements', version: '1.9', relocatable: true })
  })
})
