// ══════════════════════════════════════════════════════════
// API de PRESETS — geração de propostas via HTTP, SEM Anthropic.
//
// Pensado pra integrações externas (ex: NEXUS Voice Router) gerarem
// a "Proposta Padrão" da Turbo via POST, recebendo só campos simples
// (cliente, valor). Endpoint público (sem auth) por enquanto.
//
// COMO REUSA A LÓGICA EXISTENTE:
// A função oficial buildProposalHTML() vive no index.html e roda no
// NAVEGADOR (depende de DOM, DOMParser, animações, etc.) — não dá pra
// rodar no Node. Em vez de reescrever a lógica, este módulo REAPROVEITA
// o MESMO material-fonte direto do index.html em tempo de execução:
//   • as 5 tags <style> base do app
//   • o bloco `extraCSS` (linearização da proposta) extraído do index
//   • o HTML real da apresentação "Sobre a Turbo" (#apres-sub-turbo)
//   • a MESMA personalização de capa (pc-*) que o app aplica
// Assim o visual bate com a proposta gerada no app, sem navegador e
// sem IA. Não altera nada do app existente.
// ══════════════════════════════════════════════════════════
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, 'index.html');

// ── Cache do material-fonte (lido 1x do index.html) ──────────
let _parts = null;
function loadParts() {
  if (_parts) return _parts;
  const raw = readFileSync(INDEX_PATH, 'utf8');
  const $ = cheerio.load(raw);

  // 1) Todas as <style> base do app (mesmo que o buildProposalHTML captura)
  const stylesHtml = $('style').map((i, el) => $.html(el)).get().join('\n');

  // 2) Bloco extraCSS (linearização + neutralização de chrome + estilos
  //    da capa personalizada pc-*). Extraído do literal no index.html.
  let extraCSS = '';
  const m = raw.match(/const extraCSS = `([\s\S]*?)`;/);
  if (m) extraCSS = m[1];

  // 3) Conteúdo interno da apresentação "Sobre a Turbo"
  const apresInner = $('#apres-sub-turbo').html() || '';

  _parts = { stylesHtml, extraCSS, apresInner };
  return _parts;
}

// ── Helpers ──────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function slugify(s) {
  return String(s || 'cliente')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'cliente';
}

// Formata número/strings em moeda BR (sem o "R$"). null se vazio.
function formatBRL(v) {
  if (v == null || v === '') return null;
  let n;
  if (typeof v === 'number') {
    n = v;
  } else {
    // aceita "5000", "5.000", "5.000,00", "R$ 5.000"
    const cleaned = String(v).replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.');
    n = Number(cleaned);
  }
  if (!isFinite(n)) return String(v);
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

// Converte src/href relativos em absolutos (baseUrl) → HTML portável,
// abre em qualquer lugar (NEXUS pode salvar/abrir fora do domínio).
function absolutize($, baseUrl) {
  const fix = (attr) => {
    $('[' + attr + ']').each((i, el) => {
      const v = $(el).attr(attr);
      if (!v) return;
      if (/^(https?:|data:|blob:|#|mailto:|tel:|\/\/)/i.test(v)) return;
      const clean = v.replace(/^\.?\//, '');
      // encodeURI preserva / e trata espaços ("fotos turbo/..", "(4)")
      $(el).attr(attr, baseUrl + '/' + encodeURI(clean));
    });
  };
  fix('src');
  fix('href');
}

// Capa personalizada — espelha replaceTurboCoverInProposal() do app.
function coverInnerHtml(cliente) {
  const safeName = escapeHtml((cliente || '').trim() || 'cliente');
  return `
      <div class="pc-bg"></div>
      <div class="pc-content">
        <img src="Logo-Turbo-branca (4).png" alt="Turbo Partners" class="pc-mark">
        <span class="pc-greeting">Olá,</span>
        <h1 class="pc-name">${safeName},</h1>
        <h1 class="pc-title">somos a <span class="pc-accent">Turbo!</span></h1>
        <div class="pc-divider"></div>
        <p class="pc-sub">Aceleramos o crescimento do seu negócio</p>
        <div class="pc-tags">
          <span class="pc-tag">E-commerce</span>
          <span class="pc-tag">Lead Generation</span>
          <span class="pc-tag">Growth</span>
        </div>
      </div>`;
}

// CSS do slide de fechamento (investimento). Escopado em .pp-api-*.
const CLOSE_CSS = `
  .pp-api-close {
    background: radial-gradient(ellipse 80% 60% at 50% 0%, rgba(155,109,255,0.14), transparent 60%), #06080f;
    padding: clamp(56px, 9vw, 130px) clamp(24px, 5vw, 80px);
    display: flex; align-items: center; justify-content: center;
    min-height: 78vh; box-sizing: border-box;
  }
  .pp-api-close-inner {
    max-width: 720px; width: 100%; text-align: center;
    display: flex; flex-direction: column; align-items: center; gap: 22px;
    font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;
  }
  .pp-api-eyebrow {
    font-size: 12px; letter-spacing: 2.6px; text-transform: uppercase;
    font-weight: 800; color: #b89aff;
  }
  .pp-api-cliente {
    font-size: clamp(28px, 4.4vw, 50px); font-weight: 900; letter-spacing: -1.4px;
    line-height: 1.05; color: #fff; margin: 0;
  }
  .pp-api-valor-card {
    background: rgba(155,109,255,0.10);
    border: 1px solid rgba(155,109,255,0.28);
    border-radius: 18px; padding: 26px 44px;
    display: flex; flex-direction: column; align-items: center; gap: 8px;
  }
  .pp-api-valor-label {
    font-size: 12px; letter-spacing: 1.8px; text-transform: uppercase;
    font-weight: 700; color: rgba(255,255,255,0.6);
  }
  .pp-api-valor {
    font-size: clamp(34px, 6vw, 60px); font-weight: 900; letter-spacing: -1px;
    background: linear-gradient(90deg, #c49bff 0%, #4d8dff 50%, #0dcfe8 100%);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
  }
  .pp-api-foot { font-size: 13px; color: rgba(255,255,255,0.5); margin: 0; }
`;

// ── Função pura: monta o HTML completo da Proposta Padrão ────
export function buildPropostaPadraoHTML({ cliente, valor, baseUrl }) {
  const { stylesHtml, extraCSS, apresInner } = loadParts();

  // Limpa + personaliza a apresentação (em um fragmento isolado)
  const $a = cheerio.load(apresInner, null, false);
  $a('script').remove();              // sem JS no documento estático
  $a('.turbo-metodo-cta').remove();   // mesmo ajuste do app: sem botão na proposta
  const cover = $a('.turbo-slide--cover');
  if (cover.length) cover.html(coverInnerHtml(cliente));
  absolutize($a, baseUrl);
  const apresHtml = $a.html();

  const valorFmt = formatBRL(valor);
  const closeSection = `
    <section class="proposal-section pp-api-close">
      <div class="pp-api-close-inner">
        <span class="pp-api-eyebrow">Proposta Comercial</span>
        <h2 class="pp-api-cliente">${escapeHtml((cliente || '').trim() || 'Cliente')}</h2>
        ${valorFmt ? `<div class="pp-api-valor-card">
          <span class="pp-api-valor-label">Investimento</span>
          <span class="pp-api-valor">R$ ${valorFmt}</span>
        </div>` : ''}
        <p class="pp-api-foot">Turbo Partners · aceleramos o crescimento do seu negócio</p>
      </div>
    </section>`;

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proposta Turbo · ${escapeHtml((cliente || '').trim() || 'Cliente')}</title>
${stylesHtml}
<style>${extraCSS}</style>
<style>${CLOSE_CSS}</style>
</head>
<body>
<section class="proposal-section proposal-section--turbo">
  <div class="apres-subview is-active">${apresHtml}</div>
</section>
${closeSection}
</body>
</html>`;
}

// ── CORS (endpoint público p/ outro app do Roberto) ─────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function baseUrlOf(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = req.get('host');
  return `${proto}://${host}`;
}

// ── Catálogo de presets disponíveis ─────────────────────────
const PRESETS = [
  {
    id: 'proposta-padrao',
    name: 'Proposta Padrão',
    slots: ['cliente', 'valor'],
  },
];

// ── Handlers HTTP ────────────────────────────────────────────
export function preflight(req, res) {
  setCors(res);
  res.statusCode = 204;
  res.end();
}

// GET /api/presets
export function listPresets(req, res) {
  setCors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(PRESETS));
}

// POST /api/presets/proposta-padrao
export function generatePropostaPadrao(req, res) {
  setCors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const body = req.body || {};
    // aceita "cliente" ou "clientName" por conveniência
    const cliente = (body.cliente || body.clientName || body.nome || '').toString().trim();
    const valor = body.valor != null ? body.valor : (body.value != null ? body.value : null);

    if (!cliente) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'bad-request', detail: 'Campo obrigatório: cliente' }));
    }

    const html = buildPropostaPadraoHTML({ cliente, valor, baseUrl: baseUrlOf(req) });
    const suggestedFilename = `proposta-padrao-${slugify(cliente)}.html`;

    res.statusCode = 200;
    res.end(JSON.stringify({ html, suggestedFilename }));
  } catch (err) {
    console.error('[api-presets] erro ao gerar proposta-padrao:', err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'server-error', detail: err.message }));
  }
}

// GET /api/presets/proposta-padrao?cliente=...&valor=...
// Versão "abrir como URL": devolve o HTML direto (text/html) pra abrir
// no navegador. É o formato que o NEXUS Voice Router usa — ele monta a
// URL com os slots e abre. Mesma geração do POST, sem Anthropic.
export function renderPropostaPadrao(req, res) {
  setCors(res);
  try {
    const q = req.query || {};
    const cliente = (q.cliente || q.clientName || q.nome || '').toString().trim();
    const valor = q.valor != null ? q.valor : (q.value != null ? q.value : null);

    if (!cliente) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end('<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;background:#0a0a0c;color:#fff;padding:40px"><h2>Faltou informar o cliente</h2><p>Use <code>?cliente=Nome&valor=5000</code></p></body>');
    }

    const html = buildPropostaPadraoHTML({ cliente, valor, baseUrl: baseUrlOf(req) });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  } catch (err) {
    console.error('[api-presets] erro ao renderizar proposta-padrao:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;background:#0a0a0c;color:#fff;padding:40px"><h2>Erro ao gerar a proposta</h2><pre>' + escapeHtml(err.message) + '</pre></body>');
  }
}
