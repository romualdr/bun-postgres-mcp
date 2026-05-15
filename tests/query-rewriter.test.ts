import { describe, expect, test } from 'bun:test'
import { MockDriver, cells } from './mock-driver'
import { rewriteForAnonymization } from '../src/lib/query-rewriter'

// ── Mock helpers ──────────────────────────────────────────────────────────────

function explainRows(plan: object) {
  return cells([{ 'QUERY PLAN': [{ Plan: plan }] }])
}

function pgAttrRows(cols: Array<{ name: string; type: string }>) {
  return cells(cols.map(c => ({ name: c.name, type: c.type })))
}

function seqScan(
  schema: string,
  table: string,
  alias: string,
  output: string[],
  extra: Record<string, unknown> = {},
) {
  return {
    'Node Type': 'Seq Scan',
    Schema: schema,
    'Relation Name': table,
    Alias: alias,
    Output: output,
    ...extra,
  }
}

const USERS_ATTR = pgAttrRows([
  { name: 'id', type: 'integer' },
  { name: 'email', type: 'text' },
  { name: 'status', type: 'character varying' },
])

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('rewriteForAnonymization', () => {
  // ── No-op cases ──────────────────────────────────────────────────────────

  test('returns original SQL when EXPLAIN has no scan nodes', async () => {
    const sql = 'SELECT 1'
    const driver = new MockDriver([
      explainRows({ 'Node Type': 'Result', Output: ['1'] }),
    ])
    expect(await rewriteForAnonymization(driver, sql)).toBe(sql)
  })

  test('returns original SQL when no sensitive columns found', async () => {
    const sql = 'SELECT id, status FROM users'
    const driver = new MockDriver([
      explainRows(seqScan('public', 'users', 'users', ['users.id', 'users.status'])),
      // sample for 'id' (not obvious) — returns non-PII value
      cells([{ id: 42 }]),
      // sample for 'status' — returns non-PII value
      cells([{ status: 'active' }]),
    ])
    expect(await rewriteForAnonymization(driver, sql)).toBe(sql)
  })

  test('returns original SQL when EXPLAIN call throws', async () => {
    const sql = 'SELECT email FROM users'
    const driver = {
      async executeQuery() {
        throw new Error('DB unreachable')
      },
      async executeParamQuery() {
        throw new Error('DB unreachable')
      },
    } as unknown as MockDriver
    expect(await rewriteForAnonymization(driver, sql)).toBe(sql)
  })

  test('returns original SQL when EXPLAIN returns null', async () => {
    const sql = 'SELECT email FROM users'
    const driver = new MockDriver([null])
    expect(await rewriteForAnonymization(driver, sql)).toBe(sql)
  })

  // ── CTE construction ─────────────────────────────────────────────────────

  test('builds CTE that nulls an obvious column', async () => {
    const driver = new MockDriver([
      explainRows(seqScan('public', 'users', 'users', ['users.email'])),
      USERS_ATTR,
    ])
    const result = await rewriteForAnonymization(driver, 'SELECT email FROM users')
    expect(result).toContain('WITH')
    expect(result).toContain(`CAST('<redacted>' AS text) AS "email"`)
    expect(result).toContain('"public"."users"')
    expect(result).toContain('SELECT email FROM _anon_public_users')
  })

  test('keeps non-sensitive columns in the CTE', async () => {
    const driver = new MockDriver([
      explainRows(seqScan('public', 'users', 'users', ['users.id', 'users.email', 'users.status'])),
      cells([{ id: 1 }]),          // sample for 'id' — not PII
      cells([{ status: 'active' }]), // sample for 'status' — not PII
      USERS_ATTR,
    ])
    const result = await rewriteForAnonymization(driver, 'SELECT id, email, status FROM users')
    expect(result).toContain('"id"')
    expect(result).toContain(`CAST('<redacted>' AS text) AS "email"`)
    expect(result).toContain('"status"')
    // id and status should NOT be cast to NULL
    expect(result).not.toMatch(/CAST\(NULL[^)]+\)\s+AS\s+"id"/)
    expect(result).not.toMatch(/CAST\(NULL[^)]+\)\s+AS\s+"status"/)
  })

  test('strips schema prefix from user query', async () => {
    const driver = new MockDriver([
      explainRows(seqScan('public', 'users', 'users', ['users.email'])),
      USERS_ATTR,
    ])
    const result = await rewriteForAnonymization(
      driver,
      'SELECT email FROM public.users',
    )
    // Schema-qualified reference replaced with safe CTE name
    expect(result).not.toMatch(/FROM public\.users/)
    expect(result).toContain('SELECT email FROM _anon_public_users')
  })

  // ── Attack vectors ───────────────────────────────────────────────────────

  test('masks function-wrapped column (SUBSTRING bypass)', async () => {
    const driver = new MockDriver([
      explainRows(
        seqScan('public', 'users', 'users', [
          'substring((users.email)::text, 1, 5)',
        ]),
      ),
      USERS_ATTR,
    ])
    const result = await rewriteForAnonymization(
      driver,
      'SELECT SUBSTRING(email, 1, 5) FROM users',
    )
    // CTE nulls email; table reference replaced with safe CTE name
    expect(result).toContain(`CAST('<redacted>' AS text) AS "email"`)
    expect(result).toContain('SELECT SUBSTRING(email, 1, 5) FROM _anon_public_users')
  })

  test('masks ENCODE base64 bypass', async () => {
    const driver = new MockDriver([
      explainRows(
        seqScan('public', 'users', 'users', [
          "encode((users.email)::bytea, 'base64'::text)",
        ]),
      ),
      USERS_ATTR,
    ])
    const result = await rewriteForAnonymization(
      driver,
      "SELECT ENCODE(email::bytea, 'base64') FROM users",
    )
    expect(result).toContain(`CAST('<redacted>' AS text) AS "email"`)
  })

  test('blocks binary search via WHERE on sensitive column', async () => {
    const driver = new MockDriver([
      explainRows(
        seqScan('public', 'users', 'users', ['users.id'], {
          Filter: "(users.email ~~ 'pascal%'::text)",
        }),
      ),
      cells([{ id: 1 }]),  // sample for 'id' (Output col, non-obvious)
      USERS_ATTR,
    ])
    // email appears only in the Filter, not in Output — CTE must still null it
    const result = await rewriteForAnonymization(
      driver,
      "SELECT COUNT(*) FROM users WHERE email LIKE 'pascal%'",
    )
    expect(result).toContain(`CAST('<redacted>' AS text) AS "email"`)
  })

  test('blocks SELECT boolean inference (email = value)', async () => {
    const driver = new MockDriver([
      explainRows(
        seqScan('public', 'users', 'users', [
          "(users.email = 'pascal@example.com'::text)",
        ]),
      ),
      USERS_ATTR,
    ])
    const result = await rewriteForAnonymization(
      driver,
      "SELECT email = 'pascal@example.com' FROM users",
    )
    expect(result).toContain(`CAST('<redacted>' AS text) AS "email"`)
  })

  // ── Value-pattern detection ───────────────────────────────────────────────

  test('detects PII value in non-obvious column and masks it', async () => {
    // 'content' is not a PII keyword — detection must come from the sampled value
    const driver = new MockDriver([
      explainRows(
        seqScan('public', 'events', 'events', ['events.content']),
      ),
      // sample for 'content' — returns an email value
      cells([{ content: 'user@example.com' }]),
      pgAttrRows([
        { name: 'id', type: 'integer' },
        { name: 'content', type: 'text' },
      ]),
    ])
    const result = await rewriteForAnonymization(
      driver,
      'SELECT content FROM events',
    )
    expect(result).toContain(`CAST('<redacted>' AS text) AS "content"`)
  })

  test('leaves non-obvious column intact when sample is safe', async () => {
    const sql = 'SELECT description FROM products'
    const driver = new MockDriver([
      explainRows(
        seqScan('public', 'products', 'products', ['products.description']),
      ),
      cells([{ description: 'A great product' }]),
    ])
    expect(await rewriteForAnonymization(driver, sql)).toBe(sql)
  })

  // ── CTE prepending ────────────────────────────────────────────────────────

  test('prepends CTEs before existing WITH clause', async () => {
    const driver = new MockDriver([
      explainRows(seqScan('public', 'users', 'users', ['users.email'])),
      USERS_ATTR,
    ])
    const result = await rewriteForAnonymization(
      driver,
      'WITH foo AS (SELECT 1) SELECT email FROM users',
    )
    expect(result).toMatch(/^WITH _anon_public_users AS/)
    expect(result).toContain('foo AS (SELECT 1)')
  })

  // ── Wildcard and quoted identifier handling ───────────────────────────────

  test('expands alias.* wildcard (e.g. row_to_json(u.*))', async () => {
    const driver = new MockDriver([
      explainRows(seqScan('public', 'user', 'u', ['row_to_json(u.*)'])),
      // wildcard expansion: pg_attribute for public.user
      pgAttrRows([
        { name: 'id', type: 'integer' },
        { name: 'email', type: 'text' },
        { name: 'status', type: 'character varying' },
      ]),
      // sample for 'id' (non-obvious)
      cells([{ id: 1 }]),
      // sample for 'status' (non-obvious)
      cells([{ status: 'active' }]),
      // pg_attribute for CTE building
      pgAttrRows([
        { name: 'id', type: 'integer' },
        { name: 'email', type: 'text' },
        { name: 'status', type: 'character varying' },
      ]),
    ])
    const result = await rewriteForAnonymization(
      driver,
      'SELECT ROW_TO_JSON(u) FROM public.user u LIMIT 3',
    )
    expect(result).toContain(`CAST('<redacted>' AS text) AS "email"`)
    expect(result).toContain('"id"')
    expect(result).toContain('"status"')
  })

  test('handles quoted identifiers in EXPLAIN output (reserved-word table names)', async () => {
    // PostgreSQL quotes reserved words: "user".email instead of user.email
    const driver = new MockDriver([
      explainRows(seqScan('public', 'user', 'user', ['"user".email ~ \'^pascal\''])),
      pgAttrRows([
        { name: 'id', type: 'integer' },
        { name: 'email', type: 'text' },
      ]),
    ])
    const result = await rewriteForAnonymization(
      driver,
      "SELECT email ~ '^pascal' FROM public.user",
    )
    expect(result).toContain(`CAST('<redacted>' AS text) AS "email"`)
  })

  // ── Bare column reference (no alias prefix) ──────────────────────────────

  test('masks bare obvious column in EXPLAIN output (no alias prefix)', async () => {
    // PostgreSQL omits alias prefix in single-table queries:
    // Output: ["((email)::text ~ '^pascal'::text)"] — no alias.email
    const driver = new MockDriver([
      explainRows(seqScan('public', 'user', 'user', ["((email)::text ~ '^pascal'::text)"])),
      pgAttrRows([
        { name: 'id', type: 'integer' },
        { name: 'email', type: 'text' },
      ]),
    ])
    const result = await rewriteForAnonymization(
      driver,
      "SELECT email ~ '^pascal' FROM public.user",
    )
    expect(result).toContain(`CAST('<redacted>' AS text) AS "email"`)
  })

  // ── Table alias handling ──────────────────────────────────────────────────

  test('resolves table alias to actual table', async () => {
    const driver = new MockDriver([
      explainRows(
        seqScan('public', 'users', 'u', ['u.email']),
      ),
      USERS_ATTR,
    ])
    // EXPLAIN uses alias 'u'; scan node maps it to public.users
    const result = await rewriteForAnonymization(
      driver,
      'SELECT u.email FROM public.users u',
    )
    expect(result).toContain(`CAST('<redacted>' AS text) AS "email"`)
    expect(result).toContain('"public"."users"')
  })
})
