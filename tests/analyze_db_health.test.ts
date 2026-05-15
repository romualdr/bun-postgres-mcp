import { describe, expect, test } from 'bun:test'
import { MockDriver, cells } from './mock-driver'
import { parseSequenceName, quoteIdent, run } from '../src/commands/analyze_db_health'

describe('quoteIdent', () => {
  test('wraps name in double quotes', () => expect(quoteIdent('users')).toBe('"users"'))
  test('escapes internal double quotes', () =>
    expect(quoteIdent('public"hack')).toBe('"public""hack"'))
  test('handles empty string', () => expect(quoteIdent('')).toBe('""'))
})

describe('parseSequenceName', () => {
  test('parses schema-qualified sequence', () =>
    expect(parseSequenceName("nextval('public.users_id_seq'::regclass)")).toEqual([
      'public',
      'users_id_seq',
    ]))

  test('defaults to public schema when unqualified', () =>
    expect(parseSequenceName("nextval('users_id_seq'::regclass)")).toEqual([
      'public',
      'users_id_seq',
    ]))

  test('strips surrounding double quotes from names', () =>
    expect(parseSequenceName("nextval('\"public\".\"my_seq\"'::regclass)")).toEqual([
      'public',
      'my_seq',
    ]))

  test('returns empty sequence name for non-nextval default', () =>
    expect(parseSequenceName('uuid_generate_v4()')).toEqual(['public', '']))
})

describe('run — invalid health type', () => {
  test('returns error message for unknown type', async () => {
    const driver = new MockDriver([])
    const result = await run(driver, 'foobar')
    expect(result).toContain("Invalid health types provided: 'foobar'")
    expect(result).toContain('Valid values are:')
  })
})

describe('run — connection', () => {
  test('reports healthy connection counts', async () => {
    const driver = new MockDriver([
      cells([{ count: 42 }]),   // total connections
      cells([{ count: 3 }]),    // idle in transaction
    ])
    const result = await run(driver, 'connection')
    expect(result).toBe('Connection health: Connections healthy: 42 total, 3 idle')
  })

  test('reports high total connection count', async () => {
    const driver = new MockDriver([
      cells([{ count: 501 }]),
      cells([{ count: 0 }]),
    ])
    const result = await run(driver, 'connection')
    expect(result).toContain('High number of connections: 501')
  })

  test('reports high idle connection count', async () => {
    const driver = new MockDriver([
      cells([{ count: 50 }]),
      cells([{ count: 101 }]),
    ])
    const result = await run(driver, 'connection')
    expect(result).toContain('High number of connections idle in transaction: 101')
  })
})

describe('run — vacuum', () => {
  test('reports healthy vacuum state when no tables at risk', async () => {
    const driver = new MockDriver([null])
    const result = await run(driver, 'vacuum')
    expect(result).toBe('Vacuum health: All tables have healthy transaction ID age.')
  })
})

describe('run — constraint', () => {
  test('reports no invalid constraints', async () => {
    const driver = new MockDriver([null])
    const result = await run(driver, 'constraint')
    expect(result).toBe('Constraint health: No invalid constraints found.')
  })

  test('reports invalid FK constraint', async () => {
    const driver = new MockDriver([
      cells([{
        schema: 'public',
        table: 'loans',
        name: 'fk_user_id',
        referenced_schema: 'public',
        referenced_table: 'users',
      }]),
    ])
    const result = await run(driver, 'constraint')
    expect(result).toContain("Constraint 'fk_user_id'")
    expect(result).toContain("table 'public.loans'")
    expect(result).toContain("'public.users'")
  })

  test('reports invalid non-FK constraint', async () => {
    const driver = new MockDriver([
      cells([{
        schema: 'public',
        table: 'orders',
        name: 'chk_amount',
        referenced_schema: null,
        referenced_table: null,
      }]),
    ])
    const result = await run(driver, 'constraint')
    expect(result).toContain("Constraint 'chk_amount' on table 'public.orders' is invalid")
  })
})

describe('run — buffer', () => {
  test('reports index and table hit rates', async () => {
    const driver = new MockDriver([
      cells([{ rate: 0.97 }]),  // index hit rate
      cells([{ rate: 0.92 }]),  // table hit rate
    ])
    const result = await run(driver, 'buffer')
    expect(result).toContain('Index cache hit rate: 97.0% (above 95.0% threshold)')
    expect(result).toContain('Table cache hit rate: 92.0% (below 95.0% threshold)')
  })

  test('reports no statistics when null', async () => {
    const driver = new MockDriver([null, null])
    const result = await run(driver, 'buffer')
    expect(result).toContain('No index cache statistics available.')
    expect(result).toContain('No table cache statistics available.')
  })
})

describe('run — index (all-clear)', () => {
  test('reports no issues when all index queries return null', async () => {
    // getIndexes (invalid check), getIndexes (duplicate check), indexBloat, unusedIndexes
    const driver = new MockDriver([null, null, null, null])
    const result = await run(driver, 'index')
    expect(result).toContain('No invalid indexes found.')
    expect(result).toContain('No duplicate indexes found.')
    expect(result).toContain('No bloated indexes found.')
    expect(result).toContain('No unused indexes found.')
  })
})

describe('run — sequence (no sequences)', () => {
  test('reports no sequences found', async () => {
    const driver = new MockDriver([null])
    const result = await run(driver, 'sequence')
    expect(result).toBe('Sequence health: No sequences found in the database.')
  })
})
