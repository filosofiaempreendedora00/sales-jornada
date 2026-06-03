// ══════════════════════════════════════════════════════════
// API REST — Melhorias (Configurações → Kanban).
//   GET    /api/melhorias            — lista todas
//   POST   /api/melhorias            — cria
//   PUT    /api/melhorias/:id        — atualiza
//   DELETE /api/melhorias/:id        — apaga
// ══════════════════════════════════════════════════════════
import { query, isConfigured } from './db.js';

function rowToMelhoria(row) {
  return {
    id: row.id,
    titulo: row.titulo,
    descricao: row.descricao || '',
    status: row.status,
    prioridade: row.prioridade,
    dataAlvo: row.data_alvo ? toISODate(row.data_alvo) : '',
    imagem: row.imagem || '',
    solicitadoPor: row.solicitado_por || '',
    criadoEm: row.created_at?.toISOString?.() || row.created_at,
    atualizadoEm: row.updated_at?.toISOString?.() || row.updated_at,
  };
}
function toISODate(d) {
  if (!d) return '';
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function notConfigured(res) {
  res.statusCode = 503;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'banco-nao-configurado' }));
}
function badRequest(res, msg) {
  res.statusCode = 400;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'bad-request', detail: msg }));
}
function serverError(res, err) {
  console.error('[api-melhorias] erro:', err);
  res.statusCode = 500;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'server-error', detail: err.message }));
}
function ok(res, body) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}
async function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

export async function listMelhorias(req, res) {
  if (!isConfigured()) return notConfigured(res);
  try {
    const r = await query('SELECT * FROM melhorias ORDER BY created_at ASC');
    ok(res, { melhorias: r.rows.map(rowToMelhoria) });
  } catch (err) { serverError(res, err); }
}

export async function createMelhoria(req, res) {
  if (!isConfigured()) return notConfigured(res);
  try {
    const b = await readJson(req);
    if (!b.id || !b.titulo) return badRequest(res, 'id e titulo obrigatórios');
    await query(`
      INSERT INTO melhorias (id, titulo, descricao, status, prioridade, data_alvo, imagem, solicitado_por)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      b.id, b.titulo, b.descricao || null,
      b.status || 'pendente', b.prioridade || 'media',
      b.dataAlvo || null, b.imagem || null, b.solicitadoPor || null,
    ]);
    ok(res, { id: b.id });
  } catch (err) { serverError(res, err); }
}

export async function updateMelhoria(req, res, id) {
  if (!isConfigured()) return notConfigured(res);
  try {
    const b = await readJson(req);
    await query(`
      UPDATE melhorias SET
        titulo = COALESCE($2, titulo),
        descricao = $3,
        status = COALESCE($4, status),
        prioridade = COALESCE($5, prioridade),
        data_alvo = $6,
        imagem = $7,
        solicitado_por = $8
      WHERE id = $1
    `, [
      id, b.titulo || null, b.descricao || null,
      b.status || null, b.prioridade || null,
      b.dataAlvo || null, b.imagem || null, b.solicitadoPor || null,
    ]);
    ok(res, { ok: true });
  } catch (err) { serverError(res, err); }
}

// Bulk replace — substitui TODAS as melhorias pelo estado enviado.
// Mesmo padrão de cases — sincronização total simples.
export async function bulkReplace(req, res) {
  if (!isConfigured()) return notConfigured(res);
  try {
    const b = await readJson(req);
    const list = Array.isArray(b.melhorias) ? b.melhorias : [];
    const { withClient } = await import('./db.js');
    await withClient(async (client) => {
      await client.query('BEGIN');
      await client.query('DELETE FROM melhorias');
      for (const m of list) {
        if (!m.id || !m.titulo) continue;
        await client.query(`
          INSERT INTO melhorias (id, titulo, descricao, status, prioridade, data_alvo, imagem, solicitado_por)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          m.id, m.titulo, m.descricao || null,
          m.status || 'pendente', m.prioridade || 'media',
          m.dataAlvo || null, m.imagem || null, m.solicitadoPor || null,
        ]);
      }
      await client.query('COMMIT');
    });
    ok(res, { ok: true, count: list.length });
  } catch (err) { serverError(res, err); }
}

export async function deleteMelhoria(req, res, id) {
  if (!isConfigured()) return notConfigured(res);
  try {
    await query('DELETE FROM melhorias WHERE id = $1', [id]);
    ok(res, { ok: true });
  } catch (err) { serverError(res, err); }
}
