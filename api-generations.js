// ══════════════════════════════════════════════════════════
// API — Histórico de gerações de proposta com IA (Configurações → Custos).
//   GET /api/generations  — lista o histórico + total gasto
// O registro (insert) é feito pelo server.js após cada geração/refino LIVE,
// via logGeneration() — server-side, pra capturar 100% das gerações mesmo se
// o navegador fechar. Nunca lança erro que quebre a geração (log é best-effort).
// ══════════════════════════════════════════════════════════
import { query, isConfigured } from './db.js';

// Preços do Claude Sonnet 4.5 (US$ por 1M tokens). Mantém em sincronia com o
// AI_PRICING do index.html. Se trocar ANTHROPIC_MODEL, ajuste os dois.
const PRICING = { in: 3.0, out: 15.0, cacheWrite: 3.75, cacheRead: 0.30 };

function costUSD(u) {
  if (!u) return 0;
  return ((u.input_tokens || 0) * PRICING.in
        + (u.output_tokens || 0) * PRICING.out
        + (u.cache_creation_input_tokens || 0) * PRICING.cacheWrite
        + (u.cache_read_input_tokens || 0) * PRICING.cacheRead) / 1e6;
}

// Registra uma geração. Best-effort: qualquer erro é logado e engolido —
// JAMAIS pode derrubar a resposta da geração.
export async function logGeneration({ clientName, proposalType, kind, model, usage, auditUsage, elapsedMs } = {}) {
  if (!isConfigured()) return;
  try {
    const u = usage || {};
    const cost = costUSD(usage) + costUSD(auditUsage);
    await query(`
      INSERT INTO generations
        (client_name, proposal_type, kind, model,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
         cost_usd, elapsed_ms)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [
      clientName || null, proposalType || null, kind || 'generate', model || null,
      u.input_tokens || 0, u.output_tokens || 0,
      u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0,
      cost, elapsedMs || 0,
    ]);
  } catch (err) {
    console.error('[api-generations] log falhou (ignorando):', err.message);
  }
}

export async function listGenerations(req, res) {
  if (!isConfigured()) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'banco-nao-configurado' }));
    return;
  }
  try {
    const r = await query('SELECT * FROM generations ORDER BY created_at DESC LIMIT 2000');
    const rows = r.rows.map(row => ({
      id: String(row.id),
      criadoEm: row.created_at?.toISOString?.() || row.created_at,
      cliente: row.client_name || '',
      tipo: row.proposal_type || '',
      kind: row.kind || 'generate',
      model: row.model || '',
      inputTokens: row.input_tokens || 0,
      outputTokens: row.output_tokens || 0,
      cacheReadTokens: row.cache_read_tokens || 0,
      cacheCreationTokens: row.cache_creation_tokens || 0,
      custoUSD: Number(row.cost_usd) || 0,
      elapsedMs: row.elapsed_ms || 0,
    }));
    const totalUSD = rows.reduce((s, x) => s + x.custoUSD, 0);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ generations: rows, totalUSD, count: rows.length }));
  } catch (err) {
    console.error('[api-generations] list erro:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'server-error', detail: err.message }));
  }
}
