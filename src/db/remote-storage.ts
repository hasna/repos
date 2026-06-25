import pg from "pg";
import type { Pool } from "pg";

function translatePlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function normalizeParams(params: unknown[]): unknown[] {
  const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
  return flat.map((value) => value === undefined ? null : value);
}

function sslConfigFor(connectionString: string): { rejectUnauthorized: boolean } | undefined {
  return connectionString.includes("sslmode=require") || connectionString.includes("ssl=true")
    ? { rejectUnauthorized: false }
    : undefined;
}

export class PgAdapterAsync {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, ssl: sslConfigFor(connectionString) });
  }

  async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
    const result = await this.pool.query(translatePlaceholders(sql), normalizeParams(params));
    return { changes: result.rowCount ?? 0 };
  }

  async get(sql: string, ...params: unknown[]): Promise<unknown> {
    const result = await this.pool.query(translatePlaceholders(sql), normalizeParams(params));
    return result.rows[0] ?? null;
  }

  async all(sql: string, ...params: unknown[]): Promise<unknown[]> {
    const result = await this.pool.query(translatePlaceholders(sql), normalizeParams(params));
    return result.rows;
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
