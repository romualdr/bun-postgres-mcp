import { afterEach, describe, expect, test } from 'bun:test'
import { MockDriver, cells } from './mock-driver'
import { resetPostgresVersionCache } from '../src/sql/extensions'
import { getStatCols, run } from '../src/commands/get_top_queries'

afterEach(() => resetPostgresVersionCache())

describe('getStatCols', () => {
  test('returns exec_time columns for pg >= 13', () => {
    const cols = getStatCols(13)
    expect(cols.totalTime).toBe('total_exec_time')
    expect(cols.meanTime).toBe('mean_exec_time')
  })

  test('returns time columns for pg 12', () => {
    const cols = getStatCols(12)
    expect(cols.totalTime).toBe('total_time')
    expect(cols.meanTime).toBe('mean_time')
  })

  test('returns wal_bytes for pg >= 13', () => {
    expect(getStatCols(15).walBytesSelect).toBe('wal_bytes')
  })

  test('returns 0 AS wal_bytes for pg 12', () => {
    expect(getStatCols(12).walBytesSelect).toBe('0 AS wal_bytes')
  })
})

describe('run — extension not installed', () => {
  test('returns install message when extension missing', async () => {
    // checkExtension: not in pg_extension → not in pg_available_extensions
    const driver = new MockDriver([null, null])
    const result = await run(driver, 'resources', 10)
    expect(result).toContain('pg_stat_statements')
    expect(result).toContain('CREATE EXTENSION')
  })
})

describe('run — total_time sort', () => {
  test('returns top queries message', async () => {
    const driver = new MockDriver([
      // checkExtension: installed
      cells([{ extversion: '1.9' }]),
      // getPostgresVersion
      cells([{ server_version: '15.0' }]),
      // main query
      cells([
        { query: 'SELECT * FROM users', calls: 100, total_exec_time: 500, mean_exec_time: 5, rows: 1000 },
      ]),
    ])
    const result = await run(driver, 'total_time', 5)
    expect(result).toContain('Top 1 slowest queries by total execution time')
    expect(result).toContain('SELECT * FROM users')
  })
})

describe('run — resources sort', () => {
  test('returns JSON array of resource-intensive queries', async () => {
    const driver = new MockDriver([
      // checkExtension: installed
      cells([{ extversion: '1.9' }]),
      // getPostgresVersion
      cells([{ server_version: '15.0' }]),
      // main query — empty result (no queries above threshold)
      null,
    ])
    const result = await run(driver, 'resources', 10)
    expect(JSON.parse(result)).toEqual([])
  })
})
