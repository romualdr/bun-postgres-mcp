import type { Driver, RowResult } from '../src/sql/driver'

export class MockDriver implements Driver {
  private idx = 0

  constructor(private readonly responses: (RowResult[] | null)[] = []) {}

  async executeQuery(_query: string): Promise<RowResult[] | null> {
    return this.responses[this.idx++] ?? null
  }

  async executeParamQuery(
    _query: string,
    _params: unknown[],
  ): Promise<RowResult[] | null> {
    return this.responses[this.idx++] ?? null
  }
}

export function cells(rows: Record<string, unknown>[]): RowResult[] {
  return rows.map((r) => ({ cells: r }))
}
