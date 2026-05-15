import type { Driver } from '../sql/driver'
import { fieldNameIsPii, REDACTED, shouldRedact } from './anonymization'

type ScanNode = { schema: string; table: string; alias: string }
type ColumnInfo = { name: string; type: string }
// "schema.table" → set of lowercase column names to null
type MaskMap = Map<string, Set<string>>

/**
 * Rewrites a SQL query to mask sensitive columns by prepending CTEs that
 * replace them with NULL.
 *
 * Uses EXPLAIN (VERBOSE, FORMAT JSON) for column lineage, so every access
 * path is covered — function wrapping (SUBSTRING, ENCODE, …), boolean
 * inference in SELECT, and WHERE-clause binary search on PII (nulling the
 * column inside the CTE means WHERE conditions on it always evaluate to NULL,
 * returning 0 rows).
 *
 * Returns the original SQL unchanged when EXPLAIN fails or no sensitive
 * columns are found.
 */
export async function rewriteForAnonymization(
  driver: Driver,
  sql: string,
): Promise<string> {
  // ── 1. EXPLAIN ────────────────────────────────────────────────────────────
  let planJson: unknown
  try {
    const rows = await driver.executeQuery(
      `EXPLAIN (VERBOSE, FORMAT JSON) ${sql}`,
      true,
    )
    if (!rows || rows.length === 0) return sql
    planJson = rows[0]?.cells?.['QUERY PLAN']
    if (typeof planJson === 'string') planJson = JSON.parse(planJson)
  } catch {
    return sql // DDL or unsupported statement; let the real query fail naturally
  }

  if (!Array.isArray(planJson) || planJson.length === 0) return sql

  // ── 2. Extract scan nodes, column references, and wildcard aliases ──────────
  const scanNodes: ScanNode[] = []
  const colRefs = new Set<string>()    // "alias.column"
  const wildcards = new Set<string>()  // aliases referenced as alias.*
  const bareObvious = new Set<string>()// bare OBVIOUS_FIELDS names (no alias prefix)
  walkPlan(
    (planJson[0] as Record<string, unknown>)?.Plan,
    scanNodes,
    colRefs,
    wildcards,
    bareObvious,
  )

  if (scanNodes.length === 0) return sql

  const aliasMap = new Map<string, ScanNode>()
  for (const node of scanNodes) aliasMap.set(node.alias, node)

  // ── 2b. Expand alias.* wildcards to explicit column refs ─────────────────
  for (const alias of wildcards) {
    const node = aliasMap.get(alias)
    if (!node) continue
    try {
      const rows = await driver.executeQuery(`
        SELECT attname AS name
        FROM   pg_catalog.pg_attribute
        WHERE  attrelid = ${ql(`${node.schema}.${node.table}`)}::regclass
          AND  attnum > 0
          AND  NOT attisdropped
      `)
      for (const r of rows ?? []) {
        colRefs.add(`${alias}.${r.cells.name as string}`)
      }
    } catch { /* inaccessible — skip */ }
  }

  // ── 3. Classify each column reference ────────────────────────────────────
  const maskMap: MaskMap = new Map()
  const nonObvious: Array<{ node: ScanNode; col: string }> = []

  // Bare OBVIOUS_FIELDS (no alias prefix) can only be attributed when there
  // is exactly one scan node — no ambiguity about which table they belong to.
  if (scanNodes.length === 1 && bareObvious.size > 0) {
    const key = tableKey(scanNodes[0]!)
    for (const col of bareObvious) getOrCreate(maskMap, key).add(col)
  }

  for (const ref of colRefs) {
    const dot = ref.indexOf('.')
    if (dot === -1) continue
    const alias = ref.slice(0, dot)
    const col = ref.slice(dot + 1).toLowerCase()
    const node = aliasMap.get(alias)
    if (!node) continue

    const key = tableKey(node)
    if (fieldNameIsPii(col)) {
      getOrCreate(maskMap, key).add(col)
    } else {
      nonObvious.push({ node, col })
    }
  }

  // ── 4. Sample non-obvious columns for value-pattern PII detection ─────────
  const sampled = new Set<string>()
  for (const { node, col } of nonObvious) {
    const key = tableKey(node)
    const dedup = `${key}.${col}`
    if (sampled.has(dedup)) continue
    sampled.add(dedup)

    try {
      const rows = await driver.executeQuery(
        `SELECT ${qi(col)} FROM ${qi(node.schema)}.${qi(node.table)} WHERE ${qi(col)} IS NOT NULL LIMIT 1`,
      )
      const value = rows?.[0]?.cells?.[col]
      if (shouldRedact(col, value)) getOrCreate(maskMap, key).add(col)
    } catch {
      // Column inaccessible or missing — skip
    }
  }

  if (maskMap.size === 0) return sql

  // ── 5. Fetch full column list + types for each table to mask ──────────────
  const tableColumns = new Map<string, ColumnInfo[]>()
  for (const key of maskMap.keys()) {
    const [schema, table] = splitKey(key)
    try {
      const rows = await driver.executeQuery(`
        SELECT attname                                              AS name,
               pg_catalog.format_type(atttypid, atttypmod)        AS type
        FROM   pg_catalog.pg_attribute
        WHERE  attrelid = ${ql(`${schema}.${table}`)}::regclass
          AND  attnum > 0
          AND  NOT attisdropped
        ORDER  BY attnum
      `)
      if (rows) {
        tableColumns.set(
          key,
          rows.map(r => ({
            name: r.cells.name as string,
            type: r.cells.type as string,
          })),
        )
      }
    } catch {
      maskMap.delete(key)
    }
  }

  if (maskMap.size === 0) return sql

  // ── 6. Build masking CTEs ─────────────────────────────────────────────────
  const ctes: string[] = []
  for (const [key, sensitive] of maskMap) {
    const [schema, table] = splitKey(key)
    const cols = tableColumns.get(key) ?? []
    if (cols.length === 0) continue

    const colList = cols
      .map(c =>
        sensitive.has(c.name.toLowerCase())
          ? `CAST(${isStringType(c.type) ? ql(REDACTED) : 'NULL'} AS ${c.type}) AS ${qi(c.name)}`
          : qi(c.name),
      )
      .join(', ')

    ctes.push(
      `${safeCteName(schema, table)} AS (SELECT ${colList} FROM ${qi(schema)}.${qi(table)})`,
    )
  }

  if (ctes.length === 0) return sql

  // ── 7. Replace all table references in query with safe CTE name ───────────
  let rewritten = sql
  for (const key of maskMap.keys()) {
    const [schema, table] = splitKey(key)
    const safe = safeCteName(schema, table)
    // Replace schema-qualified form first (public.user, public."user")
    rewritten = rewritten.replace(
      new RegExp(`\\b${reEscape(schema)}\\."?${reEscape(table)}"?`, 'gi'),
      safe,
    )
    // Replace remaining bare references ("user" quoted, or \buser\b unquoted)
    rewritten = rewritten
      .replace(new RegExp(`"${reEscape(table)}"`, 'gi'), safe)
      .replace(new RegExp(`\\b${reEscape(table)}\\b`, 'gi'), safe)
  }

  return prependCTEs(rewritten, ctes)
}

// ── Plan walker ───────────────────────────────────────────────────────────────

function walkPlan(
  node: unknown,
  scanNodes: ScanNode[],
  colRefs: Set<string>,
  wildcards: Set<string>,
  bareObvious: Set<string>,
): void {
  if (!node || typeof node !== 'object') return

  const n = node as Record<string, unknown>

  // Collect table scan metadata (Seq Scan, Index Scan, Bitmap Heap Scan, …)
  if (
    typeof n['Relation Name'] === 'string' &&
    typeof n['Schema'] === 'string' &&
    typeof n['Alias'] === 'string'
  ) {
    scanNodes.push({
      schema: n['Schema'],
      table: n['Relation Name'],
      alias: n['Alias'],
    })
  }

  // Extract column refs from every string / array-of-string in the node
  for (const val of Object.values(n)) {
    if (typeof val === 'string') {
      extractColRefs(val, colRefs, wildcards, bareObvious)
    } else if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === 'string') extractColRefs(item, colRefs, wildcards, bareObvious)
        else walkPlan(item, scanNodes, colRefs, wildcards, bareObvious)
      }
    } else {
      walkPlan(val, scanNodes, colRefs, wildcards, bareObvious)
    }
  }
}

// Matches alias.column — applied after stripping double-quote wrapping
const COL_REF_RE = /\b([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\b/g
// Matches alias.* (wildcard row reference, e.g. row_to_json(u.*))
const WILDCARD_RE = /\b([a-zA-Z_][a-zA-Z0-9_]*)\.\*/g

function extractColRefs(s: string, out: Set<string>, wildcards: Set<string>, bareObvious: Set<string>): void {
  // Strip PostgreSQL double-quote identifier wrapping so "user".email → user.email
  const unquoted = s.replace(/"([^"]+)"/g, '$1')
  for (const [, alias] of unquoted.matchAll(WILDCARD_RE)) {
    if (alias) wildcards.add(alias)
  }
  for (const [, alias, col] of unquoted.matchAll(COL_REF_RE)) {
    out.add(`${alias}.${col}`)
  }
  // Detect bare column names (no alias prefix) — PostgreSQL omits alias in
  // single-table queries. Strip string literals and ::type casts first, then
  // check each word-boundary identifier against OBVIOUS_FIELDS.
  const stripped = unquoted
    .replace(/'[^']*'/g, '')        // remove string literals
    .replace(/::[a-zA-Z_][a-zA-Z0-9_ ]*/g, '') // remove ::type casts
  for (const [, word] of stripped.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g)) {
    if (word && fieldNameIsPii(word)) bareObvious.add(word.toLowerCase())
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function prependCTEs(sql: string, ctes: string[]): string {
  const list = ctes.join(',\n  ')
  const trimmed = sql.trimStart()
  const m = /^WITH(\s+RECURSIVE)?\b/i.exec(trimmed)
  if (m) {
    // Preserve WITH [RECURSIVE] and insert our CTEs before existing ones
    const keyword = m[1] ? 'WITH RECURSIVE' : 'WITH'
    return `${keyword} ${list},\n  ${trimmed.slice(m[0].length).trimStart()}`
  }
  return `WITH ${list}\n${trimmed}`
}

function getOrCreate(map: MaskMap, key: string): Set<string> {
  if (!map.has(key)) map.set(key, new Set())
  return map.get(key)!
}

function tableKey(node: ScanNode): string {
  return `${node.schema}.${node.table}`
}

function splitKey(key: string): [string, string] {
  const dot = key.indexOf('.')
  return [key.slice(0, dot), key.slice(dot + 1)]
}

/** Returns true for PostgreSQL types that can hold a '<redacted>' string. */
function isStringType(pgType: string): boolean {
  const t = pgType.toLowerCase()
  return (
    t === 'text' ||
    t === 'name' ||
    t === 'citext' ||
    t.startsWith('character') ||
    t.startsWith('varchar')
  )
}

/** Collision-safe CTE name: avoids reserved words like "user". */
function safeCteName(schema: string, table: string): string {
  return `_anon_${schema}_${table}`
}

/** Quote a PostgreSQL identifier. */
function qi(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** Quote a PostgreSQL string literal. */
function ql(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** Escape special characters for use in a RegExp. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
