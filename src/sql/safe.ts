import type { RowResult } from './driver.ts'
import { SqlDriver } from './driver.ts'

const ALLOWED_PREFIXES = [
  'select',
  'show',
  'explain',
  'vacuum',
  'analyze',
  'create extension',
  'with ',
  'deallocate',
  'declare',
  'fetch',
  'close',
]

const FORBIDDEN_PATTERNS = [
  /\binsert\b/i,
  /\bupdate\b/i,
  /\bdelete\b/i,
  /\bdrop\b/i,
  /\balter\b/i,
  /\btruncate\b/i,
  /\bgrant\b/i,
  /\brevoke\b/i,
  /\bcreate\s+(?!extension)/i,
]

export function validate(query: string): void {
  const normalized = query
    .replace(/\/\*.*?\*\//gs, '')
    .replace(/--[^\n]*/g, '')
    .trim()
    .toLowerCase()

  const allowed = ALLOWED_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix),
  )
  if (!allowed) {
    throw new Error(
      `Query type not allowed. Only SELECT, SHOW, EXPLAIN, VACUUM, ANALYZE, CREATE EXTENSION, and cursor statements are permitted.`,
    )
  }

  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(normalized)) {
      throw new Error(`Forbidden SQL operation detected in query.`)
    }
  }
}

export class SafeSqlDriver extends SqlDriver {
  private readonly timeout: number | null

  constructor(driver: SqlDriver, timeout?: number) {
    super(driver.pool)
    this.timeout = timeout ?? null
  }

  override async executeQuery(query: string): Promise<RowResult[] | null> {
    validate(query)
    const prefixed = `/* postgres-client */ ${query}`

    if (this.timeout) {
      const result = await Promise.race([
        super.executeQuery(prefixed, true),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Query timed out after ${this.timeout}s`)),
            this.timeout! * 1000,
          ),
        ),
      ])
      return result
    }

    return super.executeQuery(prefixed, true)
  }

  override async executeParamQuery(
    query: string,
    params: unknown[],
  ): Promise<RowResult[] | null> {
    validate(query)
    const prefixed = `/* postgres-client */ ${query}`
    return super.executeParamQuery(prefixed, params)
  }
}
