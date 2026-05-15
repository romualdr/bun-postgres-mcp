import { SQL } from 'bun'

export function obfuscatePassword(
  text: string | null | undefined,
): string | null | undefined {
  if (!text) return text

  try {
    const url = new URL(text)
    if (url.password) {
      url.password = '****'
      return url.toString()
    }
  } catch {}

  text = text.replace(
    /(postgres(?:ql)?:\/\/[^:]+:)([^@]+)(@[^\/\s]+)/g,
    '$1****$3',
  )
  text = text.replace(/(password=)([^\s&;"']+)/gi, '$1****')
  text = text.replace(/(password\s*=\s*')([^']+)(')/gi, '$1****$3')
  text = text.replace(/(password\s*=\s*")([^"]+)(")/gi, '$1****$3')

  return text
}

export interface RowResult {
  cells: Record<string, unknown>
}

export interface Driver {
  executeQuery(query: string, forceReadonly?: boolean): Promise<RowResult[] | null>
  executeParamQuery(query: string, params: unknown[]): Promise<RowResult[] | null>
}

export class SQLPool {
  private _sql: SQL | null = null
  private _isValid = false
  private _lastError: string | null = null
  private connectionUrl: string | null = null

  constructor(connectionUrl?: string) {
    if (connectionUrl) this.connectionUrl = connectionUrl
  }

  async connect(connectionUrl?: string): Promise<SQL> {
    if (this._sql && this._isValid) return this._sql

    const url = connectionUrl ?? this.connectionUrl
    if (!url) {
      this._lastError = 'Database connection URL not provided'
      throw new Error(this._lastError)
    }

    this.connectionUrl = url
    await this.close()

    try {
      this._sql = new SQL(url)
      await this._sql`SELECT 1`
      this._isValid = true
      this._lastError = null
      return this._sql
    } catch (e) {
      this._isValid = false
      this._lastError = String(e)
      await this.close()
      throw new Error(
        `Connection attempt failed: ${obfuscatePassword(String(e))}`,
      )
    }
  }

  async close(): Promise<void> {
    if (this._sql) {
      try {
        await this._sql.close()
      } catch (e) {
        console.warn(`Error closing connection: ${e}`)
      } finally {
        this._sql = null
        this._isValid = false
      }
    }
  }

  get isValid(): boolean {
    return this._isValid
  }

  get lastError(): string | null {
    return this._lastError
  }
}

export class SqlDriver {
  constructor(readonly pool: SQLPool) {}

  async executeQuery(
    query: string,
    forceReadonly = false,
  ): Promise<RowResult[] | null> {
    const db = await this.pool.connect()

    let rows: Record<string, unknown>[]

    if (forceReadonly) {
      rows = await db.begin(async (tx) => {
        await tx.unsafe('SET TRANSACTION READ ONLY')
        return tx.unsafe(query) as Promise<Record<string, unknown>[]>
      })
    } else {
      rows = (await db.unsafe(query)) as Record<string, unknown>[]
    }

    if (!rows || rows.length === 0) return null
    return rows.map((r) => ({ cells: r }))
  }

  async executeParamQuery(
    query: string,
    params: unknown[],
  ): Promise<RowResult[] | null> {
    const db = await this.pool.connect()
    const rows = (await db.unsafe(
      query,
      params as Parameters<typeof db.unsafe>[1],
    )) as Record<string, unknown>[]
    if (!rows || rows.length === 0) return null
    return rows.map((r) => ({ cells: r }))
  }
}
