// ══════════════════════════════════════════════════════════
// db.js — pool de conexão Postgres + helper de migrations.
// Credenciais via process.env. NENHUM dado sensível no código.
// Render: configure DB_HOST, DB_NAME, DB_USER, DB_PASSWORD nas
// variáveis de ambiente do serviço.
// ══════════════════════════════════════════════════════════
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;

function buildPool() {
  const host = process.env.DB_HOST;
  const database = process.env.DB_NAME;
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;
  const port = parseInt(process.env.DB_PORT || '5432', 10);

  if (!host || !database || !user || !password) {
    console.warn('[db] credenciais ausentes — endpoints DB devolverão 503.');
    return null;
  }

  return new Pool({
    host, port, database, user, password,
    ssl: process.env.DB_SSL === '1' ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
  });
}

export const pool = buildPool();

export async function query(sql, params) {
  if (!pool) throw new Error('Banco não configurado.');
  return pool.query(sql, params);
}

export async function withClient(fn) {
  if (!pool) throw new Error('Banco não configurado.');
  const client = await pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

export const isConfigured = () => !!pool;

export async function runMigrations() {
  if (!pool) { console.log('[db] sem credencial — pulando migrations.'); return { skipped: true }; }
  const dir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(dir)) return { ran: 0 };
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  let ran = 0;
  await withClient(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    for (const f of files) {
      const exists = await client.query('SELECT 1 FROM _migrations WHERE filename = $1', [f]);
      if (exists.rowCount > 0) continue;
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations(filename) VALUES ($1)', [f]);
        await client.query('COMMIT');
        ran++;
        console.log(`[db] migration aplicada: ${f}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[db] FALHA na migration ${f}:`, err.message);
        throw err;
      }
    }
  });
  return { ran };
}
