// ══════════════════════════════════════════════════════════
// load-env.js — carrega .env local ANTES de qualquer módulo que
// leia process.env (ex: db.js). Importado como PRIMEIRA linha do
// server.js pra rodar no topo da cadeia de imports ESM.
//
// Seguro pra produção: se não existir .env (Render injeta as env
// vars direto), simplesmente não faz nada — sem erro.
// ══════════════════════════════════════════════════════════
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '.env');

if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(envPath);
    console.log('[env] .env local carregado.');
  } catch (e) {
    console.warn('[env] falha ao carregar .env:', e.message);
  }
}
