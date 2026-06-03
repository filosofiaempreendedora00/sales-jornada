// ══════════════════════════════════════════════════════════
// API REST — Cases (e suas Soluções aninhadas).
// Endpoints:
//   GET    /api/cases                       — lista todos (com soluções)
//   POST   /api/cases                       — cria
//   PUT    /api/cases/:id                   — atualiza
//   DELETE /api/cases/:id                   — apaga (CASCADE em solucoes)
//   POST   /api/cases/:id/solucoes/replace  — substitui solucoes do case
// ══════════════════════════════════════════════════════════
import { query, withClient, isConfigured } from './db.js';

const CASE_FIELDS = [
  'id','nicho_id','subnicho','nome','instagram','site',
  'faturamento_inicial','faturamento_atual','ticket_medio',
  'prazo_evolucao','trabalho_realizado','estrategia_aplicada','observacoes',
];
const SOL_FIELDS = [
  'id','case_id','sol_cat_id','nome','icon','stage','url','conteudo','ordem',
];

function rowToCase(row, solucoes = []) {
  return {
    id: row.id,
    nichoId: row.nicho_id,
    subnicho: row.subnicho,
    nome: row.nome,
    instagram: row.instagram || '',
    site: row.site || '',
    faturamentoInicial: row.faturamento_inicial || '',
    faturamentoAtual: row.faturamento_atual || '',
    ticketMedio: row.ticket_medio || '',
    prazoEvolucao: row.prazo_evolucao || '',
    trabalhoRealizado: row.trabalho_realizado || '',
    estrategiaAplicada: row.estrategia_aplicada || '',
    observacoes: row.observacoes || '',
    criadoEm: row.created_at?.toISOString?.() || row.created_at,
    solucoes,
  };
}
function rowToSol(row) {
  return {
    id: row.id,
    solCatId: row.sol_cat_id || '',
    nome: row.nome,
    icon: row.icon || '',
    stage: row.stage || '',
    url: row.url || '',
    conteudo: row.conteudo || '',
    ordem: row.ordem,
    criadoEm: row.created_at?.toISOString?.() || row.created_at,
  };
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
  console.error('[api-cases] erro:', err);
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

// Lista todos os cases com suas soluções (1 query + 1 query batch)
export async function listCases(req, res) {
  if (!isConfigured()) return notConfigured(res);
  try {
    const cases = await query('SELECT * FROM cases ORDER BY created_at ASC');
    const sols = await query('SELECT * FROM solucoes ORDER BY case_id, ordem, created_at ASC');
    const byCase = new Map();
    sols.rows.forEach(s => {
      if (!byCase.has(s.case_id)) byCase.set(s.case_id, []);
      byCase.get(s.case_id).push(rowToSol(s));
    });
    const body = cases.rows.map(c => rowToCase(c, byCase.get(c.id) || []));
    ok(res, { cases: body });
  } catch (err) { serverError(res, err); }
}

// Cria case (sem soluções — usar replace pra elas)
export async function createCase(req, res) {
  if (!isConfigured()) return notConfigured(res);
  try {
    const b = await readJson(req);
    if (!b.id || !b.nichoId || !b.subnicho || !b.nome) {
      return badRequest(res, 'id, nichoId, subnicho e nome são obrigatórios');
    }
    await query(`
      INSERT INTO cases (id, nicho_id, subnicho, nome, instagram, site,
                         faturamento_inicial, faturamento_atual, ticket_medio,
                         prazo_evolucao, trabalho_realizado, estrategia_aplicada, observacoes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    `, [
      b.id, b.nichoId, b.subnicho, b.nome,
      b.instagram || null, b.site || null,
      b.faturamentoInicial || null, b.faturamentoAtual || null, b.ticketMedio || null,
      b.prazoEvolucao || null, b.trabalhoRealizado || null,
      b.estrategiaAplicada || null, b.observacoes || null,
    ]);
    ok(res, { id: b.id });
  } catch (err) { serverError(res, err); }
}

export async function updateCase(req, res, id) {
  if (!isConfigured()) return notConfigured(res);
  try {
    const b = await readJson(req);
    await query(`
      UPDATE cases SET
        nicho_id = COALESCE($2, nicho_id),
        subnicho = COALESCE($3, subnicho),
        nome = COALESCE($4, nome),
        instagram = $5,
        site = $6,
        faturamento_inicial = $7,
        faturamento_atual = $8,
        ticket_medio = $9,
        prazo_evolucao = $10,
        trabalho_realizado = $11,
        estrategia_aplicada = $12,
        observacoes = $13
      WHERE id = $1
    `, [
      id, b.nichoId || null, b.subnicho || null, b.nome || null,
      b.instagram || null, b.site || null,
      b.faturamentoInicial || null, b.faturamentoAtual || null, b.ticketMedio || null,
      b.prazoEvolucao || null, b.trabalhoRealizado || null,
      b.estrategiaAplicada || null, b.observacoes || null,
    ]);
    ok(res, { ok: true });
  } catch (err) { serverError(res, err); }
}

export async function deleteCase(req, res, id) {
  if (!isConfigured()) return notConfigured(res);
  try {
    await query('DELETE FROM cases WHERE id = $1', [id]);
    ok(res, { ok: true });
  } catch (err) { serverError(res, err); }
}

// Bulk replace — substitui TODOS os cases (+ solucoes) pelo estado
// enviado pelo cliente. Estratégia simples: ideal pra um único
// usuário/sincronização total. Não escala pra muitos clientes
// concorrentes, mas pro nosso caso (poucos vendedores, baixa freq)
// é suficiente e elimina a necessidade de diff client-side.
export async function bulkReplace(req, res) {
  if (!isConfigured()) return notConfigured(res);
  try {
    const b = await readJson(req);
    const list = Array.isArray(b.cases) ? b.cases : [];
    await withClient(async (client) => {
      await client.query('BEGIN');
      await client.query('DELETE FROM solucoes');
      await client.query('DELETE FROM cases');
      for (const c of list) {
        if (!c.id || !c.nichoId || !c.subnicho || !c.nome) continue;
        await client.query(`
          INSERT INTO cases (id, nicho_id, subnicho, nome, instagram, site,
                             faturamento_inicial, faturamento_atual, ticket_medio,
                             prazo_evolucao, trabalho_realizado, estrategia_aplicada, observacoes)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        `, [
          c.id, c.nichoId, c.subnicho, c.nome,
          c.instagram || null, c.site || null,
          c.faturamentoInicial || null, c.faturamentoAtual || null, c.ticketMedio || null,
          c.prazoEvolucao || null, c.trabalhoRealizado || null,
          c.estrategiaAplicada || null, c.observacoes || null,
        ]);
        const sols = Array.isArray(c.solucoes) ? c.solucoes : [];
        for (let i = 0; i < sols.length; i++) {
          const s = sols[i];
          if (!s.id || !s.nome) continue;
          await client.query(`
            INSERT INTO solucoes (id, case_id, sol_cat_id, nome, icon, stage, url, conteudo, ordem)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `, [
            s.id, c.id, s.solCatId || null, s.nome, s.icon || null,
            s.stage || null, s.url || null, s.conteudo || null, i,
          ]);
        }
      }
      await client.query('COMMIT');
    });
    ok(res, { ok: true, count: list.length });
  } catch (err) { serverError(res, err); }
}

// Substitui TODAS as soluções de um case por uma nova lista.
// Mais simples que diff client-side e mais robusto.
export async function replaceSolucoes(req, res, caseId) {
  if (!isConfigured()) return notConfigured(res);
  try {
    const b = await readJson(req);
    const list = Array.isArray(b.solucoes) ? b.solucoes : [];
    await withClient(async (client) => {
      await client.query('BEGIN');
      await client.query('DELETE FROM solucoes WHERE case_id = $1', [caseId]);
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (!s.id || !s.nome) continue;
        await client.query(`
          INSERT INTO solucoes (id, case_id, sol_cat_id, nome, icon, stage, url, conteudo, ordem)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [
          s.id, caseId, s.solCatId || null, s.nome, s.icon || null,
          s.stage || null, s.url || null, s.conteudo || null, i,
        ]);
      }
      await client.query('COMMIT');
    });
    ok(res, { ok: true, count: list.length });
  } catch (err) { serverError(res, err); }
}
