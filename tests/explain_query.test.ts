import { describe, expect, test } from 'bun:test'
import { MockDriver, cells } from './mock-driver'
import { run } from '../src/commands/explain_query'

const PLAN = [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Seq Scan', 'Total Cost': 1.5 } }] }]

describe('run', () => {
  test('returns JSON of the first row cells', async () => {
    const driver = new MockDriver([cells(PLAN)])
    const result = JSON.parse(await run(driver, 'SELECT 1', false))
    expect(result['QUERY PLAN'][0].Plan['Node Type']).toBe('Seq Scan')
  })

  test('returns {} when driver returns null', async () => {
    const driver = new MockDriver([null])
    expect(await run(driver, 'SELECT 1', false)).toBe('{}')
  })

  test('prefixes EXPLAIN (FORMAT JSON) when analyze=false', async () => {
    let captured = ''
    const driver = {
      async executeQuery(q: string) {
        captured = q
        return cells(PLAN)
      },
      async executeParamQuery() {
        return null
      },
    }
    await run(driver, 'SELECT 1', false)
    expect(captured).toStartWith('EXPLAIN (FORMAT JSON)')
    expect(captured).not.toContain('ANALYZE')
  })

  test('prefixes EXPLAIN (ANALYZE, FORMAT JSON) when analyze=true', async () => {
    let captured = ''
    const driver = {
      async executeQuery(q: string) {
        captured = q
        return cells(PLAN)
      },
      async executeParamQuery() {
        return null
      },
    }
    await run(driver, 'SELECT 1', true)
    expect(captured).toStartWith('EXPLAIN (ANALYZE, FORMAT JSON)')
  })
})
