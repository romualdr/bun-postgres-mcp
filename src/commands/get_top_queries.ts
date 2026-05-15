import type { McpServer } from '@modelcontextprotocol/server'
import z from 'zod'
import type { Arguments } from '../constants'
import { textResult } from '../lib/utils'
import type { SQL } from '../sql'
import type { Driver } from '../sql/driver'
import { checkExtension, getPostgresVersion } from '../sql/extensions'

const INSTALL_MSG =
  'The pg_stat_statements extension is required to report slow queries, but it is not currently installed.\n\n' +
  'You can install it by running: `CREATE EXTENSION pg_stat_statements;`\n\n' +
  '**What does it do?** It records statistics (like execution time, number of calls, rows returned) for every query executed against the database.\n\n' +
  "**Is it safe?** Installing 'pg_stat_statements' is generally safe and a standard practice for performance monitoring. It adds overhead by tracking statistics, but this is usually negligible unless under extreme load."

export function getStatCols(pgVersion: number) {
  if (pgVersion >= 13) {
    return {
      totalTime: 'total_exec_time',
      meanTime: 'mean_exec_time',
      stddevTime: 'stddev_exec_time',
      walBytesSelect: 'wal_bytes',
      walBytesFrac:
        'wal_bytes / NULLIF(SUM(wal_bytes) OVER (), 0) AS total_wal_bytes_frac',
    }
  }
  return {
    totalTime: 'total_time',
    meanTime: 'mean_time',
    stddevTime: 'stddev_time',
    walBytesSelect: '0 AS wal_bytes',
    walBytesFrac: '0 AS total_wal_bytes_frac',
  }
}

export async function run(
  driver: Driver,
  sort_by: 'total_time' | 'mean_time' | 'resources',
  limit: number,
): Promise<string> {
  const ext = await checkExtension(driver, 'pg_stat_statements', false)
  if (!ext.isInstalled) return INSTALL_MSG

  const pgVersion = await getPostgresVersion(driver)
  const cols = getStatCols(pgVersion)

  if (sort_by === 'resources') {
    const threshold = 0.05
    const query = `
      WITH resource_fractions AS (
        SELECT
          query,
          calls,
          rows,
          ${cols.totalTime} AS total_exec_time,
          ${cols.meanTime} AS mean_exec_time,
          ${cols.stddevTime} AS stddev_exec_time,
          shared_blks_hit,
          shared_blks_read,
          shared_blks_dirtied,
          ${cols.walBytesSelect},
          ${cols.totalTime} / NULLIF(SUM(${cols.totalTime}) OVER (), 0) AS total_exec_time_frac,
          (shared_blks_hit + shared_blks_read) / NULLIF(SUM(shared_blks_hit + shared_blks_read) OVER (), 0) AS shared_blks_accessed_frac,
          shared_blks_read / NULLIF(SUM(shared_blks_read) OVER (), 0) AS shared_blks_read_frac,
          shared_blks_dirtied / NULLIF(SUM(shared_blks_dirtied) OVER (), 0) AS shared_blks_dirtied_frac,
          ${cols.walBytesFrac}
        FROM pg_stat_statements
      )
      SELECT
        query, calls, rows,
        total_exec_time, mean_exec_time, stddev_exec_time,
        total_exec_time_frac, shared_blks_accessed_frac,
        shared_blks_read_frac, shared_blks_dirtied_frac,
        total_wal_bytes_frac,
        shared_blks_hit, shared_blks_read, shared_blks_dirtied,
        wal_bytes
      FROM resource_fractions
      WHERE
        total_exec_time_frac > ${threshold}
        OR shared_blks_accessed_frac > ${threshold}
        OR shared_blks_read_frac > ${threshold}
        OR shared_blks_dirtied_frac > ${threshold}
        OR total_wal_bytes_frac > ${threshold}
      ORDER BY total_exec_time DESC
    `
    const rows = await driver.executeQuery(query)
    return JSON.stringify(rows?.map((r) => r.cells) ?? [])
  }

  const orderCol = sort_by === 'total_time' ? cols.totalTime : cols.meanTime
  const criteria =
    sort_by === 'total_time'
      ? 'total execution time'
      : 'mean execution time per call'

  const rows = await driver.executeQuery(`
    SELECT
      query,
      calls,
      ${cols.totalTime},
      ${cols.meanTime},
      rows
    FROM pg_stat_statements
    ORDER BY ${orderCol} DESC
    LIMIT ${limit}
  `)
  const queries = rows?.map((r) => r.cells) ?? []
  return `Top ${queries.length} slowest queries by ${criteria}:\n${JSON.stringify(queries)}`
}

export const register = async (
  _parameters: Arguments,
  mcp: McpServer,
  sql: SQL,
) => {
  mcp.registerTool(
    'get_top_queries',
    {
      description:
        "Reports the slowest or most resource-intensive queries using data from the 'pg_stat_statements' extension.",
      inputSchema: z.object({
        sort_by: z
          .enum(['total_time', 'mean_time', 'resources'])
          .default('resources')
          .describe(
            "Ranking criteria: 'total_time' for total execution time, 'mean_time' for mean execution time per call, or 'resources' for resource-intensive queries",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .default(10)
          .describe(
            'Number of queries to return when ranking based on mean_time or total_time',
          ),
      }),
      annotations: { title: 'Get Top Queries', readOnlyHint: true },
    },
    async ({ sort_by, limit }) =>
      textResult(await run(sql.client, sort_by, limit)),
  )
}
