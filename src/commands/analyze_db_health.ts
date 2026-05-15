import type { McpServer } from '@modelcontextprotocol/server'
import z from 'zod'
import type { Arguments } from '../constants'
import { textResult } from '../lib/utils'
import type { SQL } from '../sql'
import type { Driver, RowResult } from '../sql/driver'

type IndexRow = Record<string, unknown> & { columns: string[] }

export function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"'
}

function rows(result: RowResult[] | null): Record<string, unknown>[] {
  return result?.map((r) => r.cells) ?? []
}

// ---- Index health ----

async function getIndexes(driver: Driver): Promise<IndexRow[]> {
  const result = await driver.executeQuery(`
    SELECT
      schemaname AS schema,
      t.relname AS table,
      ix.relname AS name,
      regexp_replace(pg_get_indexdef(i.indexrelid), '^[^(]*[(](.*)[)]$', '\\1') AS columns,
      regexp_replace(pg_get_indexdef(i.indexrelid), '.* USING ([^ ]*) [(].*', '\\1') AS using,
      indisunique AS unique,
      indisprimary AS primary,
      indisvalid AS valid,
      indexprs::text,
      indpred::text,
      pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_index i
    INNER JOIN pg_class t ON t.oid = i.indrelid
    INNER JOIN pg_class ix ON ix.oid = i.indexrelid
    LEFT JOIN pg_stat_user_indexes ui ON ui.indexrelid = i.indexrelid
    WHERE schemaname IS NOT NULL
    ORDER BY 1, 2
  `)
  return (result ?? []).map((r) => {
    const rawCols = String(r.cells['columns'] ?? '')
    const columns = rawCols
      .replace(') WHERE (', ' WHERE ')
      .split(', ')
      .map((c) => c.trim().replace(/^"|"$/g, ''))
    return { ...r.cells, columns } as IndexRow
  })
}

function indexCovers(indexed: string[], cols: string[]): boolean {
  return indexed.slice(0, cols.length).join(',') === cols.join(',')
}

async function invalidIndexCheck(driver: Driver): Promise<string> {
  const indexes = await getIndexes(driver)
  const invalid = indexes.filter((i) => !i['valid'])
  if (!invalid.length) return 'No invalid indexes found.'
  return (
    'Invalid indexes found:\n' +
    invalid.map((i) => `${i['name']} on ${i['table']} is invalid.`).join('\n')
  )
}

async function duplicateIndexCheck(driver: Driver): Promise<string> {
  const indexes = await getIndexes(driver)
  const byTable: Record<string, typeof indexes> = {}
  for (const idx of indexes) {
    const key = `${idx['schema']}.${idx['table']}`
    ;(byTable[key] ??= []).push(idx)
  }

  const dups: {
    unneeded: (typeof indexes)[0]
    covering: (typeof indexes)[0]
  }[] = []
  for (const idx of indexes) {
    if (!idx['valid'] || idx['primary'] || idx['unique']) continue
    const tableIndexes = byTable[`${idx['schema']}.${idx['table']}`] ?? []
    for (const cov of tableIndexes) {
      if (
        cov['valid'] &&
        cov['name'] !== idx['name'] &&
        indexCovers(cov['columns'] as string[], idx['columns'] as string[]) &&
        cov['using'] === idx['using'] &&
        cov['indexprs'] === idx['indexprs'] &&
        cov['indpred'] === idx['indpred']
      ) {
        if (
          (cov['columns'] as string[]).join(',') !==
            (idx['columns'] as string[]).join(',') ||
          String(idx['name']) > String(cov['name']) ||
          cov['primary'] ||
          cov['unique']
        ) {
          dups.push({ unneeded: idx, covering: cov })
          break
        }
      }
    }
  }

  if (!dups.length) return 'No duplicate indexes found.'
  return (
    'Duplicate indexes found:\n' +
    dups
      .sort(
        (a, b) =>
          String(a.unneeded['table']).localeCompare(
            String(b.unneeded['table']),
          ) ||
          String(a.unneeded['columns']).localeCompare(
            String(b.unneeded['columns']),
          ),
      )
      .map(
        (d) =>
          `Index '${d.unneeded['name']}' on table '${d.unneeded['table']}' is covered by index '${d.covering['name']}'`,
      )
      .join('\n')
  )
}

async function indexBloat(driver: Driver): Promise<string> {
  const minSize = 104857600 // 100 MB
  const result = await driver.executeQuery(`
    WITH btree_index_atts AS (
      SELECT nspname, relname, reltuples, relpages, indrelid, relam,
        regexp_split_to_table(indkey::text, ' ')::smallint AS attnum,
        indexrelid AS index_oid
      FROM pg_index
      JOIN pg_class ON pg_class.oid = pg_index.indexrelid
      JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
      JOIN pg_am ON pg_class.relam = pg_am.oid
      WHERE pg_am.amname = 'btree'
    ),
    index_item_sizes AS (
      SELECT i.nspname, i.relname, i.reltuples, i.relpages, i.relam,
        (quote_ident(s.schemaname) || '.' || quote_ident(s.tablename))::regclass AS starelid,
        a.attrelid AS table_oid, index_oid,
        current_setting('block_size')::numeric AS bs,
        CASE WHEN version() ~ 'mingw32' OR version() ~ '64-bit' THEN 8 ELSE 4 END AS maxalign,
        24 AS pagehdr,
        CASE WHEN max(coalesce(s.null_frac, 0)) = 0 THEN 2 ELSE 6 END AS index_tuple_hdr,
        sum((1 - coalesce(s.null_frac, 0)) * coalesce(s.avg_width, 2048)) AS nulldatawidth
      FROM pg_attribute AS a
      JOIN pg_stats AS s
        ON (quote_ident(s.schemaname) || '.' || quote_ident(s.tablename))::regclass = a.attrelid
        AND s.attname = a.attname
      JOIN btree_index_atts AS i ON i.indrelid = a.attrelid AND a.attnum = i.attnum
      WHERE a.attnum > 0
      GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
    ),
    index_aligned AS (
      SELECT maxalign, bs, nspname, relname AS index_name, reltuples, relpages, relam,
        table_oid, index_oid,
        (2 +
          maxalign - CASE WHEN index_tuple_hdr % maxalign = 0 THEN maxalign ELSE index_tuple_hdr % maxalign END
          + nulldatawidth + maxalign - CASE WHEN nulldatawidth::integer % maxalign = 0 THEN maxalign ELSE nulldatawidth::integer % maxalign END
        )::numeric AS nulldatahdrwidth,
        pagehdr
      FROM index_item_sizes AS s1
    ),
    otta_calc AS (
      SELECT bs, nspname, table_oid, index_oid, index_name, relpages,
        coalesce(
          ceil((reltuples * (4 + nulldatahdrwidth)) / (bs - pagehdr::float))
          + CASE WHEN am.amname IN ('hash', 'btree') THEN 1 ELSE 0 END, 0
        ) AS otta
      FROM index_aligned AS s2
      LEFT JOIN pg_am am ON s2.relam = am.oid
    ),
    raw_bloat AS (
      SELECT nspname, c.relname AS table_name, index_name,
        bs * (sub.relpages)::bigint AS totalbytes,
        CASE WHEN sub.relpages <= otta THEN 0
          ELSE bs * (sub.relpages - otta)::bigint END AS wastedbytes,
        CASE WHEN sub.relpages <= otta THEN 0
          ELSE bs * (sub.relpages - otta)::bigint * 100 / (bs * (sub.relpages)::bigint) END AS realbloat,
        pg_relation_size(sub.table_oid) AS table_bytes,
        stat.idx_scan AS index_scans,
        stat.indexrelid
      FROM otta_calc AS sub
      JOIN pg_class AS c ON c.oid = sub.table_oid
      JOIN pg_stat_user_indexes AS stat ON sub.index_oid = stat.indexrelid
    )
    SELECT
      nspname AS schema,
      table_name AS table,
      index_name AS index,
      wastedbytes AS bloat_bytes,
      totalbytes AS index_bytes,
      pg_get_indexdef(rb.indexrelid) AS definition,
      indisprimary AS primary
    FROM raw_bloat rb
    INNER JOIN pg_index i ON i.indexrelid = rb.indexrelid
    WHERE wastedbytes >= ${minSize}
    ORDER BY wastedbytes DESC, index_name
  `)

  if (!result?.length) return 'No bloated indexes found.'
  return (
    'Bloated indexes found:\n' +
    rows(result)
      .map((idx) => {
        const bloatMb = Number(idx['bloat_bytes']) / 1048576
        const totalMb = Number(idx['index_bytes']) / 1048576
        return `Index '${idx['index']}' on table '${idx['table']}' has ${bloatMb.toFixed(1)}MB bloat out of ${totalMb.toFixed(1)}MB total size`
      })
      .join('\n')
  )
}

async function unusedIndexes(driver: Driver): Promise<string> {
  const maxScans = 50
  const result = await driver.executeQuery(`
    SELECT
      schemaname AS schema,
      relname AS table,
      indexrelname AS index,
      pg_relation_size(i.indexrelid) AS size_bytes,
      idx_scan AS index_scans,
      pg_get_indexdef(i.indexrelid) AS definition,
      indisprimary AS primary
    FROM pg_stat_user_indexes ui
    INNER JOIN pg_index i ON ui.indexrelid = i.indexrelid
    WHERE NOT indisunique AND idx_scan <= ${maxScans}
    ORDER BY pg_relation_size(i.indexrelid) DESC, relname ASC
  `)

  const idxs = rows(result).filter((i) => !i['primary'])
  if (!idxs.length) return 'No unused indexes found.'
  return (
    'Rarely used indexes found:\n' +
    idxs
      .map(
        (idx) =>
          `Index '${idx['index']}' on table '${idx['table']}' has only been scanned ${idx['index_scans']} times and uses ${(Number(idx['size_bytes']) / 1048576).toFixed(1)}MB of space`,
      )
      .join('\n')
  )
}

// ---- Connection health ----

async function connectionHealth(driver: Driver): Promise<string> {
  const maxTotal = 500
  const maxIdle = 100

  const totalResult = await driver.executeQuery(
    'SELECT COUNT(*) AS count FROM pg_stat_activity',
  )
  const total = Number(rows(totalResult)[0]?.['count'] ?? 0)

  const idleResult = await driver.executeQuery(
    "SELECT COUNT(*) AS count FROM pg_stat_activity WHERE state = 'idle in transaction'",
  )
  const idle = Number(rows(idleResult)[0]?.['count'] ?? 0)

  if (total > maxTotal) return `High number of connections: ${total}`
  if (idle > maxIdle)
    return `High number of connections idle in transaction: ${idle}`
  return `Connections healthy: ${total} total, ${idle} idle`
}

// ---- Vacuum health ----

async function vacuumHealth(driver: Driver): Promise<string> {
  const threshold = 10_000_000
  const maxValue = 2_146_483_648

  const result = await driver.executeQuery(`
    SELECT
      n.nspname AS schema,
      c.relname AS table,
      ${maxValue} - GREATEST(AGE(c.relfrozenxid), AGE(t.relfrozenxid)) AS transactions_left
    FROM pg_class c
    INNER JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_class t ON c.reltoastrelid = t.oid
    WHERE
      c.relkind = 'r'
      AND (${maxValue} - GREATEST(AGE(c.relfrozenxid), AGE(t.relfrozenxid))) < ${threshold}
    ORDER BY 3, 1, 2
  `)

  const tables = rows(result)
  if (!tables.length) return 'All tables have healthy transaction ID age.'

  const unhealthy = tables.filter(
    (r) => Number(r['transactions_left']) < threshold,
  )
  if (!unhealthy.length) return 'All tables have healthy transaction ID age.'

  return (
    'Tables approaching transaction ID wraparound:\n' +
    unhealthy
      .map(
        (r) =>
          `Table '${r['schema']}.${r['table']}' has ${Number(r['transactions_left']).toLocaleString()} transactions remaining before wraparound (threshold: ${threshold.toLocaleString()})`,
      )
      .join('\n')
  )
}

// ---- Sequence health ----

export function parseSequenceName(defaultValue: string): [string, string] {
  const match = /nextval\(\(?'([^']+)'/.exec(defaultValue)
  if (!match?.[1]) return ['public', '']
  const clean = match[1].replace(/"/g, '')
  const parts = clean.split('.')
  if (parts.length === 1) return ['public', parts[0] ?? '']
  return [parts[0] ?? 'public', parts[1] ?? '']
}

async function sequenceHealth(driver: Driver): Promise<string> {
  const threshold = 0.9

  const seqResult = await driver.executeQuery(`
    SELECT
      n.nspname AS table_schema,
      c.relname AS table,
      attname AS column,
      format_type(a.atttypid, a.atttypmod) AS column_type,
      pg_get_expr(d.adbin, d.adrelid) AS default_value
    FROM pg_catalog.pg_attribute a
    INNER JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    INNER JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    INNER JOIN pg_catalog.pg_attrdef d ON (a.attrelid, a.attnum) = (d.adrelid, d.adnum)
    WHERE
      NOT a.attisdropped
      AND a.attnum > 0
      AND pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval%'
      AND n.nspname NOT LIKE 'pg\\_temp\\_%'
  `)

  if (!seqResult?.length) return 'No sequences found in the database.'

  const metrics: {
    schema: string
    table: string
    column: string
    sequence: string
    columnType: string
    lastValue: number
    maxValue: number
    percentUsed: number
  }[] = []

  for (const r of rows(seqResult)) {
    const [schema, sequence] = parseSequenceName(
      String(r['default_value'] ?? ''),
    )
    if (!sequence) continue

    const maxValue =
      r['column_type'] === 'integer'
        ? 2_147_483_647
        : Number(9223372036854775807n)
    const qualifiedSeq = `${quoteIdent(schema)}.${quoteIdent(sequence)}`

    try {
      const attrResult = await driver.executeQuery(`
        SELECT
          has_sequence_privilege(format('%I.%I', '${schema.replace(/'/g, "''")}', '${sequence.replace(/'/g, "''")}'), 'SELECT') AS readable,
          last_value
        FROM ${qualifiedSeq}
      `)
      const attr = rows(attrResult)[0]
      if (!attr || !attr['readable']) continue

      const lastValue = Number(attr['last_value'])
      metrics.push({
        schema,
        table: String(r['table']),
        column: String(r['column']),
        sequence,
        columnType: String(r['column_type']),
        lastValue,
        maxValue,
        percentUsed: (lastValue / maxValue) * 100,
      })
    } catch {
      continue
    }
  }

  if (!metrics.length) return 'No sequences found in the database.'

  metrics.sort((a, b) => a.maxValue - a.lastValue - (b.maxValue - b.lastValue))
  const unhealthy = metrics.filter((m) => m.lastValue / m.maxValue > threshold)
  if (!unhealthy.length) return 'All sequences have healthy usage levels.'

  return (
    'Sequences approaching maximum value:\n' +
    unhealthy
      .map((m) => {
        const remaining = m.maxValue - m.lastValue
        return (
          `Sequence '${m.schema}.${m.sequence}' used for ${m.table}.${m.column} ` +
          `has used ${m.percentUsed.toFixed(1)}% of available values ` +
          `(${m.lastValue.toLocaleString()} of ${m.maxValue.toLocaleString()}, ${remaining.toLocaleString()} remaining)`
        )
      })
      .join('\n')
  )
}

// ---- Replication health ----

async function getServerVersionNum(driver: Driver): Promise<number> {
  const result = await driver.executeQuery('SHOW server_version_num')
  return Number(rows(result)[0]?.['server_version_num'] ?? 0)
}

async function replicationHealth(driver: Driver): Promise<string> {
  const isReplicaResult = await driver.executeQuery(
    'SELECT pg_is_in_recovery()',
  )
  const isReplica = Boolean(
    rows(isReplicaResult)[0]?.['pg_is_in_recovery'] ?? false,
  )

  const versionNum = await getServerVersionNum(driver)
  const parts: string[] = []

  if (isReplica) {
    parts.push('This is a replica database.')

    try {
      const isReplicatingResult = await driver.executeQuery(
        'SELECT state FROM pg_stat_replication',
      )
      const isReplicating = (isReplicatingResult?.length ?? 0) > 0
      parts.push(
        isReplicating
          ? 'Replica is actively replicating from primary.'
          : 'WARNING: Replica is not actively replicating from primary!',
      )
    } catch {
      // not a primary, no pg_stat_replication rows expected
    }

    try {
      const lagCondition =
        versionNum >= 100000
          ? 'pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn()'
          : 'pg_last_xlog_receive_location() = pg_last_xlog_replay_location()'
      const lagResult = await driver.executeQuery(`
        SELECT CASE
          WHEN NOT pg_is_in_recovery() OR ${lagCondition} THEN 0
          ELSE EXTRACT(EPOCH FROM NOW() - pg_last_xact_replay_timestamp())
        END AS replication_lag
      `)
      const lag = Number(rows(lagResult)[0]?.['replication_lag'] ?? 0)
      parts.push(
        lag === 0
          ? 'No replication lag detected.'
          : `Replication lag: ${lag.toFixed(1)} seconds`,
      )
    } catch {
      // lag not available
    }
  } else {
    parts.push('This is a primary database.')

    try {
      const stateResult = await driver.executeQuery(
        'SELECT state FROM pg_stat_replication',
      )
      parts.push(
        (stateResult?.length ?? 0) > 0
          ? 'Has active replicas connected.'
          : 'No active replicas connected.',
      )
    } catch {
      parts.push('No active replicas connected.')
    }
  }

  if (versionNum >= 90400) {
    try {
      const slotResult = await driver.executeQuery(`
        SELECT slot_name, database, active FROM pg_replication_slots
      `)
      const slots = rows(slotResult)
      if (slots.length) {
        const active = slots.filter((s) => s['active'])
        const inactive = slots.filter((s) => !s['active'])
        if (active.length) {
          parts.push(
            '\nActive replication slots:\n' +
              active
                .map((s) => `- ${s['slot_name']} (database: ${s['database']})`)
                .join('\n'),
          )
        }
        if (inactive.length) {
          parts.push(
            '\nInactive replication slots:\n' +
              inactive
                .map((s) => `- ${s['slot_name']} (database: ${s['database']})`)
                .join('\n'),
          )
        }
      } else {
        parts.push('\nNo replication slots found.')
      }
    } catch {
      parts.push('\nNo replication slots found.')
    }
  }

  return parts.join('\n')
}

// ---- Buffer health ----

async function bufferIndexHitRate(driver: Driver): Promise<string> {
  const threshold = 0.95
  const result = await driver.executeQuery(`
    SELECT
      (sum(idx_blks_hit)) / nullif(sum(idx_blks_hit + idx_blks_read), 0) AS rate
    FROM pg_statio_user_indexes
  `)
  const rate = rows(result)[0]?.['rate']
  if (rate == null) return 'No index cache statistics available.'
  const pct = Number(rate) * 100
  const thresholdPct = threshold * 100
  return `Index cache hit rate: ${pct.toFixed(1)}% (${pct >= thresholdPct ? 'above' : 'below'} ${thresholdPct.toFixed(1)}% threshold)`
}

async function bufferTableHitRate(driver: Driver): Promise<string> {
  const threshold = 0.95
  const result = await driver.executeQuery(`
    SELECT
      sum(heap_blks_hit) / nullif(sum(heap_blks_hit + heap_blks_read), 0) AS rate
    FROM pg_statio_user_tables
  `)
  const rate = rows(result)[0]?.['rate']
  if (rate == null) return 'No table cache statistics available.'
  const pct = Number(rate) * 100
  const thresholdPct = threshold * 100
  return `Table cache hit rate: ${pct.toFixed(1)}% (${pct >= thresholdPct ? 'above' : 'below'} ${thresholdPct.toFixed(1)}% threshold)`
}

// ---- Constraint health ----

async function constraintHealth(driver: Driver): Promise<string> {
  const result = await driver.executeQuery(`
    SELECT
      nsp.nspname AS schema,
      rel.relname AS table,
      con.conname AS name,
      fnsp.nspname AS referenced_schema,
      frel.relname AS referenced_table
    FROM pg_catalog.pg_constraint con
    INNER JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid
    LEFT JOIN pg_catalog.pg_class frel ON frel.oid = con.confrelid
    LEFT JOIN pg_catalog.pg_namespace nsp ON nsp.oid = con.connamespace
    LEFT JOIN pg_catalog.pg_namespace fnsp ON fnsp.oid = frel.relnamespace
    WHERE con.convalidated = 'f'
  `)
  const constraints = rows(result)
  if (!constraints.length) return 'No invalid constraints found.'
  return (
    'Invalid constraints found:\n' +
    constraints
      .map((c) =>
        c['referenced_table']
          ? `Constraint '${c['name']}' on table '${c['schema']}.${c['table']}' referencing '${c['referenced_schema']}.${c['referenced_table']}' is invalid`
          : `Constraint '${c['name']}' on table '${c['schema']}.${c['table']}' is invalid`,
      )
      .join('\n')
  )
}

// ---- Main tool ----

const HEALTH_TYPES = [
  'index',
  'connection',
  'vacuum',
  'sequence',
  'replication',
  'buffer',
  'constraint',
  'all',
] as const

export async function run(
  driver: Driver,
  health_type: string,
): Promise<string> {
  let types: string[]
  try {
    types = health_type.split(',').map((t) => t.trim())
    const invalid = types.filter(
      (t) => !HEALTH_TYPES.includes(t as (typeof HEALTH_TYPES)[number]),
    )
    if (invalid.length) {
      return (
        `Invalid health types provided: '${invalid.join(', ')}'. ` +
        `Valid values are: ${HEALTH_TYPES.join(', ')}. ` +
        'Please try again with a comma-separated list of valid health types.'
      )
    }
  } catch {
    return `Invalid health_type: '${health_type}'`
  }

  if (types.includes('all')) {
    types = HEALTH_TYPES.filter((t) => t !== 'all') as string[]
  }

  const results: string[] = []

  if (types.includes('index')) {
    results.push('Invalid index check: ' + (await invalidIndexCheck(driver)))
    results.push(
      'Duplicate index check: ' + (await duplicateIndexCheck(driver)),
    )
    results.push('Index bloat: ' + (await indexBloat(driver)))
    results.push('Unused index check: ' + (await unusedIndexes(driver)))
  }

  if (types.includes('connection')) {
    results.push('Connection health: ' + (await connectionHealth(driver)))
  }

  if (types.includes('vacuum')) {
    results.push('Vacuum health: ' + (await vacuumHealth(driver)))
  }

  if (types.includes('sequence')) {
    results.push('Sequence health: ' + (await sequenceHealth(driver)))
  }

  if (types.includes('replication')) {
    results.push('Replication health: ' + (await replicationHealth(driver)))
  }

  if (types.includes('buffer')) {
    results.push(
      'Buffer health for indexes: ' + (await bufferIndexHitRate(driver)),
    )
    results.push(
      'Buffer health for tables: ' + (await bufferTableHitRate(driver)),
    )
  }

  if (types.includes('constraint')) {
    results.push('Constraint health: ' + (await constraintHealth(driver)))
  }

  return results.length
    ? results.join('\n')
    : 'No health checks were performed.'
}

export const register = async (
  _parameters: Arguments,
  mcp: McpServer,
  sql: SQL,
) => {
  mcp.registerTool(
    'analyze_db_health',
    {
      description:
        'Analyzes database health. Available checks:\n' +
        '- index: checks for invalid, duplicate, bloated, and unused indexes\n' +
        '- connection: checks connection count and utilization\n' +
        '- vacuum: checks vacuum health for transaction ID wraparound\n' +
        '- sequence: checks sequences at risk of exceeding their maximum value\n' +
        '- replication: checks replication health including lag and slots\n' +
        '- buffer: checks buffer cache hit rates for indexes and tables\n' +
        '- constraint: checks for invalid constraints\n' +
        '- all: runs all checks',
      inputSchema: z.object({
        health_type: z
          .string()
          .default('all')
          .describe(
            `Comma-separated health check types. Valid values: ${HEALTH_TYPES.join(', ')}.`,
          ),
      }),
      annotations: { title: 'Analyze Database Health', readOnlyHint: true },
    },
    async ({ health_type }) => textResult(await run(sql.client, health_type)),
  )
}
