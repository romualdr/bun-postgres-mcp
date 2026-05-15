import { describe, expect, test } from 'bun:test'
import { MockDriver, cells } from './mock-driver'
import { run } from '../src/commands/execute_sql'

// EXPLAIN response with no scan nodes — tells the rewriter there is nothing to mask
const EXPLAIN_NOOP = cells([{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Result', Output: ['1'] } }] }])

describe('run', () => {
  test('returns "No results" when query returns null', async () => {
    const driver = new MockDriver([null])
    expect(await run(driver, 'SELECT 1', false)).toBe('No results')
  })

  test('returns JSON of rows', async () => {
    const driver = new MockDriver([cells([{ id: 1, name: 'Alice' }])])
    const result = JSON.parse(await run(driver, 'SELECT id, name FROM users', false))
    expect(result).toEqual([{ id: 1, name: 'Alice' }])
  })

  test('returns multiple rows', async () => {
    const driver = new MockDriver([
      cells([{ id: 1, status: 'active' }, { id: 2, status: 'inactive' }]),
    ])
    const result = JSON.parse(await run(driver, 'SELECT id, status FROM users', false))
    expect(result).toHaveLength(2)
    expect(result[1].status).toBe('inactive')
  })

  test('anonymizes obvious fields when anonymize=true', async () => {
    const driver = new MockDriver([
      EXPLAIN_NOOP,  // rewriter: no scan nodes → pass through
      cells([{ id: 1, email: 'alice@example.com', first_name: 'Alice' }]),
    ])
    const result = JSON.parse(await run(driver, 'SELECT * FROM users', true))
    expect(result[0].email).toBe('<redacted>')
    expect(result[0].first_name).toBe('<redacted>')
    expect(result[0].id).toBe(1)
  })

  test('anonymizes detected email value on non-obvious field when anonymize=true', async () => {
    const driver = new MockDriver([
      EXPLAIN_NOOP,
      cells([{ payload: 'user@example.com' }]),
    ])
    const result = JSON.parse(await run(driver, 'SELECT payload FROM t', true))
    expect(result[0].payload).toBe('<redacted>')
  })

  test('does not anonymize when anonymize=false', async () => {
    const driver = new MockDriver([
      cells([{ id: 1, email: 'alice@example.com' }]),
    ])
    const result = JSON.parse(await run(driver, 'SELECT * FROM users', false))
    expect(result[0].email).toBe('alice@example.com')
  })
})
