import { AccessMode } from '../constants'
import { print_usage } from '../lib/utils'
import { SqlDriver, SQLPool } from './driver'
import { SafeSqlDriver } from './safe'

export class SQL {
  mode: AccessMode
  isConnected = false
  private _pool: SQLPool | null = null
  private _client: SqlDriver | null = null

  constructor() {
    this.mode = AccessMode.RESTRICTED
  }

  setMode(access_mode: AccessMode) {
    this.mode = access_mode
    this._client = null
  }

  async connect(url?: string) {
    if (url) this._pool = new SQLPool(url)
    if (!this._pool)
      return print_usage({
        exit: 1,
        message:
          'Error: DATABASE_URL is required to establish a database connection.',
      }) as never
    await this._pool.connect()
  }

  close() {
    if (!this._pool) return
    this._pool.close()
    this._pool = null
    this._client = null
  }

  private get pool() {
    if (!this._pool)
      return print_usage({
        exit: 1,
        message:
          'Error: No database connection. Please call sql.connect(DATABASE_URL) first.',
      }) as never
    return this._pool
  }

  get client() {
    if (this._client) return this._client
    const driver = new SqlDriver(this.pool)
    if (this.mode === AccessMode.RESTRICTED)
      this._client = new SafeSqlDriver(driver, 30)
    else this._client = driver
    return this._client
  }
}
