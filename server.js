// ─────────────────────────────────────────────────────────
//  server.js — Web server for Jornada Online
//
//  Responsabilidades:
//  1) Servir todos os arquivos estáticos (index.html, propostas,
//     imagens, vídeos) exatamente como o static server fazia antes.
//  2) Expor endpoints /api/* para a feature de geração de propostas
//     com IA (Anthropic Claude).
//
//  Princípios:
//  - Drop-in replacement do http-server: tudo que servia antes
//    continua servindo, sem cache forçado e com CORS liberado.
//  - Se ANTHROPIC_API_KEY não estiver definida, o endpoint de IA
//    entra em modo MOCK (retorna o template intacto + log), pra que
//    o front-end possa ser testado sem queimar token.
//  - Defesa em profundidade: limites de payload, timeouts, validação
//    de entradas, mensagens de erro que NÃO vazam stack traces.
// ─────────────────────────────────────────────────────────

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFile } from 'fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import * as cheerio from 'cheerio';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const HAS_AI = Boolean(ANTHROPIC_API_KEY);

const PROPOSAL_FILES = {
  '00': 'proposta-lancamento.html',
  '01': 'proposta-performance-mql.html',
  '02': 'proposta-reguas.html',
};

// Limites generosos pra suportar transcrições longas + HTMLs grandes.
const MAX_JSON_BODY = '8mb';
const MAX_TRANSCRIPT_CHARS = 200_000; // ~50k tokens por transcrição
const MAX_REFINEMENT_CHARS = 5_000;
// Gerações podem demorar 3-5min facilmente (Sonnet produzindo HTML grande).
// Usamos SSE/streaming pra que o proxy do Render não derrube por idle.
const REQUEST_TIMEOUT_MS = 10 * 60_000; // 10 min

// ── Anthropic client (lazy) ─────────────────────────────
let anthropic = null;
if (HAS_AI) {
  anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
}

// ── App ─────────────────────────────────────────────────
const app = express();

// CORS aberto pra mesma origem; sem credenciais.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: MAX_JSON_BODY }));

// ── Health check ────────────────────────────────────────
// Front usa pra feature-flag: se /api/health responde, mostra "Gerar".
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    ai: HAS_AI ? 'live' : 'mock',
    model: HAS_AI ? ANTHROPIC_MODEL : null,
    ts: Date.now(),
    streaming: true, // marca a versão com streaming SSE
  });
});

// ── Health stream — testa SSE sem chamar Anthropic ──────
// Útil pra diagnosticar se proxy/streaming está OK independente da IA.
app.get('/api/health-stream', (req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write(':' + ' '.repeat(2048) + '\n\n');
  if (typeof res.flush === 'function') res.flush();
  let i = 0;
  const t = setInterval(() => {
    i++;
    res.write(`data: ${JSON.stringify({ type: 'tick', n: i, ts: Date.now() })}\n\n`);
    if (typeof res.flush === 'function') res.flush();
    if (i >= 5) {
      clearInterval(t);
      res.write(`data: ${JSON.stringify({ type: 'done', total: i })}\n\n`);
      res.end();
    }
  }, 1000);
  req.on('close', () => clearInterval(t));
});

// ── Helpers ─────────────────────────────────────────────
function validateGenerateInput(body) {
  const errors = [];
  const transcripts = Array.isArray(body.transcripts)
    ? body.transcripts.filter(t => typeof t === 'string' && t.trim().length > 0)
    : [];
  if (transcripts.length === 0) {
    errors.push('Forneça ao menos uma transcrição com conteúdo.');
  }
  for (const t of transcripts) {
    if (t.length > MAX_TRANSCRIPT_CHARS) {
      errors.push(`Transcrição muito longa (limite: ${MAX_TRANSCRIPT_CHARS} chars).`);
      break;
    }
  }
  const proposalType = String(body.proposalType || '').trim();
  if (!PROPOSAL_FILES[proposalType]) {
    errors.push('Tipo de proposta inválido. Use 00, 01 ou 02.');
  }
  const clientName = (typeof body.clientName === 'string' ? body.clientName : '').trim().slice(0, 80);
  if (!clientName) {
    errors.push('Nome do cliente é obrigatório.');
  }
  const refinement = typeof body.refinement === 'string' ? body.refinement.trim() : '';
  if (refinement.length > MAX_REFINEMENT_CHARS) {
    errors.push(`Instrução de refinamento muito longa (limite: ${MAX_REFINEMENT_CHARS} chars).`);
  }
  const currentHtml = typeof body.currentHtml === 'string' ? body.currentHtml : '';
  return { errors, transcripts, proposalType, clientName, refinement, currentHtml };
}

async function loadTemplate(proposalType) {
  const file = PROPOSAL_FILES[proposalType];
  if (!file) throw new Error('Tipo inválido');
  const filePath = path.join(__dirname, file);
  return await readFile(filePath, 'utf8');
}

// ── Extração de textos editáveis (DIFF strategy) ────────
// Em vez de pedir pra IA reescrever 25k tokens de HTML, marcamos
// cada texto editável com data-edit-id e mandamos só o JSON dos
// textos. IA retorna JSON com as substituições. Server aplica.
// Resultado: ~5x menos output, ~10x mais rápido, ~10x mais barato.

// IDs com totais computados / valores controlados por tier — NÃO editáveis.
const PROTECTED_IDS = new Set([
  'perf-creatives', 'perf-price', 'perf-budget',
  'bundle-perf-price', 'bundle-perf-budget', 'bundle-total',
  'inv-tier-price', 'inv-item-tier',
  'proj-pay-note', 'proj-tier-note',
  'proj-legend-rec', 'proj-legend-ins', 'proj-total',
]);

// Selectors a inspecionar
const EDITABLE_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, span, div, em, strong, button';

// Tags inline aceitáveis dentro de um leaf editável
const INLINE_TAGS = new Set(['strong','em','i','b','small','br','u','mark','sup','sub','span']);

// Tags que NUNCA são editáveis (containers estruturais, controles, mídia)
const NEVER_EDITABLE = new Set(['nav','svg','script','style','iframe','video','img','input','select','textarea']);

function isLeafEditable($, el) {
  const $el = $(el);
  // Forbidden by ID
  const id = $el.attr('id');
  if (id && PROTECTED_IDS.has(id)) return false;
  // Dentro de container proibido?
  if ($el.closest('nav, script, style, iframe, video, svg').length > 0) return false;
  // Dentro de outro elemento já marcado? evita parent + child duplicado
  if ($el.parents('[data-edit-id]').length > 0) return false;
  // Tem que ter texto
  const text = $el.text().trim();
  if (text.length === 0) return false;
  // Texto não pode ser absurdamente longo (provavelmente é container)
  if (text.length > 800) return false;
  // Children devem ser só inline simples (ou texto)
  const childTags = $el.children().toArray().map(c => (c.tagName || '').toLowerCase());
  for (const tag of childTags) {
    if (!INLINE_TAGS.has(tag)) return false;
  }
  return true;
}

function extractEditableTexts(html) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const texts = {};
  let counter = 0;
  $(EDITABLE_SELECTOR).each((_, el) => {
    if (!isLeafEditable($, el)) return;
    counter++;
    const id = `t-${String(counter).padStart(3, '0')}`;
    $(el).attr('data-edit-id', id);
    // Preserva HTML inline interno (strong, em, br) pra Claude poder
    // reescrever mantendo emphasis. Tira o data-edit-id do próprio HTML
    // retornado (que vai pro JSON).
    const innerHtml = $(el).html().trim();
    texts[id] = innerHtml;
  });
  return { html: $.html(), texts };
}

function applyPatches(htmlWithIds, patches, clientName) {
  const $ = cheerio.load(htmlWithIds, { decodeEntities: false });
  let applied = 0;
  for (const [id, newHtml] of Object.entries(patches)) {
    if (typeof newHtml !== 'string') continue;
    const $el = $(`[data-edit-id="${id}"]`);
    if ($el.length === 0) continue;
    $el.html(newHtml);
    applied++;
  }
  // Atualiza o <title> também (caso não tenha vindo nos patches)
  // pra refletir o cliente.
  if (clientName) {
    const currentTitle = $('title').text();
    // Heurística: troca menções a Digital Aligner / Luma / Haira no title
    const updatedTitle = currentTitle
      .replace(/Digital Aligner/gi, clientName)
      .replace(/\bLuma\b/g, clientName)
      .replace(/\bHaira\b/g, clientName);
    if (updatedTitle !== currentTitle) {
      $('title').text(updatedTitle);
    }
  }
  return { html: $.html(), applied };
}

// Termos do template original que NÃO devem sobrar na proposta gerada.
// Detectados pós-geração; se sobrarem, segunda passada na IA corrige.
const TEMPLATE_LEAK_TERMS = {
  '00': [ // Lançamento — Haira
    'Haira',
  ],
  '01': [ // Performance com MQL — Luma
    'Luma',
  ],
  '02': [ // Réguas — Digital Aligner
    'Digital Aligner',
    'dentista', 'dentistas',
    'alinhador', 'alinhadores',
    'ortodontia', 'ortodontista', 'ortodôntic',
    'odontológic', 'odontologia',
    'paciente', 'pacientes',
    'consultório', 'clínica odontológica',
    'Juliana',
  ],
};

// Procura por termos vazados do template no HTML pós-patch.
// Retorna { 'id': { html, found: ['term1', 'term2'] } } pros IDs afetados.
function findLeakIds(htmlWithIds, terms) {
  if (!terms?.length) return {};
  const $ = cheerio.load(htmlWithIds, { decodeEntities: false });
  const leaks = {};
  // Regex de cada termo (case-insensitive, escape de chars especiais)
  const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp('\\b(' + escaped.join('|') + ')', 'i');
  $('[data-edit-id]').each((_, el) => {
    const $el = $(el);
    const id = $el.attr('data-edit-id');
    const text = $el.text();
    if (re.test(text)) {
      const found = terms.filter(t => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text));
      leaks[id] = { html: $el.html(), found };
    }
  });
  return leaks;
}

// Segunda passada na IA pra corrigir os leaks detectados.
// Recebe só os IDs que vazaram + lista de termos a evitar.
async function callAIForLeakFix({ leaks, terms, clientName, transcriptsBlock }) {
  const leakJson = Object.fromEntries(
    Object.entries(leaks).map(([id, v]) => [id, v.html])
  );
  const termsList = terms.join(', ');
  const systemPrompt = `Você é copywriter da Turbo Partners. Recebe um JSON de textos que ainda contêm termos do template original que DEVEM ser substituídos para refletir o cliente real.

CLIENTE: ${clientName}
TERMOS A SUBSTITUIR: ${termsList}

Para cada texto:
- Substitua os termos antigos por contexto apropriado ao cliente ${clientName}
- Mantenha TODAS as tags HTML inline (<em>, <strong>, <br>, <span>) com mesmas classes/atributos
- Tom premium, profissional, sóbrio
- NÃO invente dados sobre o cliente — use linguagem genérica se não houver info específica
- Retorne SOMENTE JSON {id: novoTexto}, sem markdown nem prefácio`;

  const response = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 4_000,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `CONTEXTO DA REUNIÃO:\n${transcriptsBlock}\n\nTEXTOS COM LEAKS (${Object.keys(leakJson).length} itens):\n${JSON.stringify(leakJson, null, 2)}\n\nReescreva TODOS removendo os termos listados. Retorne JSON puro.`,
    }],
  });

  const text = response.content?.[0]?.text || '';
  const patches = extractJson(text);
  return { patches: patches || {}, usage: response.usage };
}

// Tenta extrair JSON de uma string que pode ter prefácio/markdown.
function extractJson(text) {
  if (!text) return null;
  // Remove fences markdown
  let s = String(text).trim()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  // Tenta parse direto
  try { return JSON.parse(s); } catch {}
  // Procura primeiro { e último }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try { return JSON.parse(s.slice(first, last + 1)); } catch {}
  return null;
}

const SYSTEM_PROMPT_GENERATE = `Você é um copywriter sênior da Turbo Partners, especialista em personalizar propostas comerciais B2B premium.

Você recebe:
1. Nome do cliente
2. Transcrição(ões) da reunião de vendas
3. Um JSON com TODOS os textos editáveis do template ({"t-001":"...","t-002":"..."})

SUA TAREFA: retornar um JSON com os IDs cujos textos você está alterando para personalizar a proposta. Seja MINUCIOSO — é melhor mudar demais que de menos.

═══════════════════════════════════════════════════
O QUE SUBSTITUIR (SEMPRE, em CADA texto onde aparecer)
═══════════════════════════════════════════════════

▶ NOMES DE CLIENTES DO TEMPLATE:
   "Digital Aligner", "Luma", "Haira" → nome do cliente real
   Variações: "a Digital", "a Luma" → "a {cliente}" ou "ao {cliente}"

▶ FOUNDERS, GESTORES, PESSOAS NOMEADAS:
   Qualquer nome próprio de pessoa do template (Juliana, etc.) → omitir,
   trocar por cargo genérico ("o time", "a liderança", "o gerente"), OU
   pelo nome real se o cliente mencionou alguém na reunião.

▶ SEGMENTO / INDÚSTRIA:
   Termos específicos do template (dentista, ortodontista, alinhador,
   clínica odontológica, escola, dentro do varejo de moda, etc.) →
   substituir pelo segmento real do cliente.
   Ex: "dentista" → "cliente Acme" / "marketplace" / "loja virtual" etc.

▶ CASOS / EXEMPLOS / BENCHMARKS DO TEMPLATE:
   Cases citados no template original (ex: "Nubank no template", "iFood",
   referências aleatórias) → trocar pelos benchmarks que o CLIENTE citou
   na reunião. Se cliente não citou nenhum, manter ou omitir o exemplo
   (não inventar).

▶ DORES / PROBLEMAS / GANCHOS:
   Adapte parágrafos de "diagnóstico" / "contexto" / "dor" para
   refletir EXATAMENTE o que o cliente verbalizou na reunião (CAC alto,
   churn, baixa retenção, falta de funil, etc.).

▶ HEADINGS E SUB-HEADINGS:
   Qualquer h1/h2/h3 que mencione cliente, segmento, ou problema do
   template original → reescrever para o contexto do cliente real.

▶ CTAs E FECHAMENTO:
   "Próxima conversa", "Vamos começar", subtítulos finais que mencionam
   o cliente → personalizar.

═══════════════════════════════════════════════════
O QUE PRESERVAR (NÃO INCLUIR no JSON de resposta)
═══════════════════════════════════════════════════

✗ Labels curtos sem contexto: "01", "02", "Etapa", "Foco", "Modelo",
  "Camada", "Output" → NÃO MUDAR.
✗ Preços, datas, números: "R$ 11.997", "20/05/2026", "6x" → NÃO MUDAR.
✗ Termos técnicos universais: "CAC", "ROAS", "CRM", "ROI", "WhatsApp",
  "E-mail" → NÃO MUDAR (a menos que precise reformular o parágrafo).
✗ Status / chips genéricos: "Aquisição", "Operando" → NÃO MUDAR.

═══════════════════════════════════════════════════
PRESERVAÇÃO DE FORMATAÇÃO (CRÍTICO)
═══════════════════════════════════════════════════

Quando o texto original tem tags HTML inline (<em>, <strong>, <i>,
<br>, <span class="...">), você DEVE manter EXATAMENTE as mesmas tags
com as MESMAS classes/atributos. Apenas o texto entre as tags muda.

Exemplo:
Original: 'A próxima camada de <em class="italic text-primary">crescimento</em> da Digital Aligner.'
OK:       'A próxima fase de <em class="italic text-primary">escala</em> da Acme Corp.'
ERRADO:   'A próxima fase de escala da Acme Corp.' (perdeu <em>)
ERRADO:   'A próxima fase de <em>escala</em> da Acme Corp.' (perdeu class)

═══════════════════════════════════════════════════
TOM DE VOZ
═══════════════════════════════════════════════════

Premium, profissional, sóbrio. Igual ao template. Nunca vendedor ou
exclamativo. Frases curtas e precisas. Português brasileiro.

═══════════════════════════════════════════════════
FORMATO DA RESPOSTA
═══════════════════════════════════════════════════

SOMENTE JSON válido, sem markdown, sem prefácio, sem comentários, sem
aspas externas. Comece DIRETAMENTE com '{' e termine com '}'.

Quantidade esperada: 20 a 60 entradas. Se passou de 70, está mudando
coisa que não precisava. Se ficou abaixo de 15, está deixando muita
coisa do template original passar.

Exemplo de formato:
{"t-002":"A próxima<br>fase de <em class=\\"italic text-primary\\">escala</em><br>da Acme Corp.","t-014":"..."}`;

const SYSTEM_PROMPT_REFINE = `Você está refinando uma proposta comercial B2B da Turbo Partners.

Você vai receber:
1. Nome do cliente
2. Transcrição(ões) da reunião de vendas (contexto)
3. Um JSON com os textos editáveis atuais da proposta (já personalizada anteriormente)
4. Uma instrução de refinamento do usuário (em linguagem natural)

Sua tarefa: aplicar APENAS o que o usuário pediu, e retornar um JSON com os IDs cujos textos você está alterando.

REGRAS:
1. Aplique exatamente o que foi pedido, nada mais. Se a instrução for ambígua, prefira interpretação conservadora.
2. Preserve tags HTML inline (<strong>, <em>, <br>, etc.) com as mesmas classes.
3. Para textos que não precisam mudar, NÃO inclua na resposta.
4. Mantenha o tom premium da marca.

FORMATO DA RESPOSTA:
SOMENTE JSON válido no formato:
{
  "t-XXX": "novo texto",
  ...
}
Sem markdown, sem prefácio.`;

function buildTranscriptsBlock(transcripts) {
  if (transcripts.length === 1) {
    return `<transcricao>\n${transcripts[0]}\n</transcricao>`;
  }
  return transcripts
    .map((t, i) => `<transcricao numero="${i + 1}" de_total="${transcripts.length}">\n${t}\n</transcricao>`)
    .join('\n\n');
}

// Sanitiza output da IA pra garantir que é HTML válido.
function sanitizeAIHtml(text) {
  if (!text) return null;
  let s = String(text).trim();
  // Tira fences markdown se ainda aparecerem.
  s = s.replace(/^```html\s*\n?/i, '').replace(/```\s*$/i, '').trim();
  s = s.replace(/^```\s*\n?/, '').replace(/```\s*$/, '').trim();
  // Tem que começar com <!DOCTYPE ou <html
  if (!/^<!DOCTYPE|^<html/i.test(s)) return null;
  // Tem que ter um </html> de fechamento
  if (!/<\/html>\s*$/i.test(s)) return null;
  return s;
}

// ── Helper: envia evento SSE ──────────────────────────
function sseSend(res, data) {
  // SSE format: "data: {json}\n\n"
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ── Endpoint: GERAR / REFINAR proposta (STREAMING via SSE) ──
// Streaming é OBRIGATÓRIO porque gerações grandes (HTML de 80kb)
// podem levar 3-5min — sem streaming, proxies (Render/Cloudflare)
// derrubam a conexão por idle ou por timeout duro de ~100s.
app.post('/api/generate-proposal', async (req, res) => {
  req.setTimeout(REQUEST_TIMEOUT_MS);
  res.setTimeout(REQUEST_TIMEOUT_MS);

  const { errors, transcripts, proposalType, clientName, refinement, currentHtml } =
    validateGenerateInput(req.body || {});

  if (errors.length) {
    return res.status(400).json({ ok: false, error: errors.join(' ') });
  }

  // Decidir modo: gerar do zero ou refinar.
  const isRefinement = refinement.length > 0 && currentHtml.length > 0;

  let baseHtml;
  try {
    baseHtml = await loadTemplate(proposalType);
  } catch (e) {
    console.error('[api] erro lendo template', proposalType, e);
    return res.status(500).json({ ok: false, error: 'Template não encontrado.' });
  }

  // ── MODO MOCK (sem API key) ────────────────────────
  // Mantém JSON simples pra mock — não precisa de streaming.
  if (!HAS_AI) {
    console.log(`[api] MOCK ${isRefinement ? 'refine' : 'generate'} — proposal ${proposalType}, transcripts: ${transcripts.length}, client: "${clientName}"`);
    const html = isRefinement ? currentHtml : baseHtml;
    const banner = `<!-- [MOCK MODE] Servidor sem ANTHROPIC_API_KEY. Esta resposta é o template/HTML atual sem alterações. -->\n`;
    const out = html.startsWith('<!DOCTYPE') ? banner + html : html;
    return res.json({
      ok: true,
      mode: 'mock',
      html: out,
      meta: {
        model: 'mock',
        transcripts: transcripts.length,
        isRefinement,
        warning: 'Backend em modo MOCK — sem ANTHROPIC_API_KEY configurado.',
      },
    });
  }

  // ── MODO LIVE (Anthropic streaming via SSE) ─────────
  // Headers SSE. flushHeaders() força o envio imediato pro proxy;
  // sem isso, Render/Cloudflare bufferizam aguardando mais dados.
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx/Render no-buffer hint
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
  // Padding inicial — alguns proxies só liberam o stream depois de
  // 1-2KB de dados. 2KB de comentário SSE é seguro e ignorado pelos
  // clients EventSource/SSE parsers.
  const padding = ':' + ' '.repeat(2048) + '\n\n';
  res.write(padding);
  if (typeof res.flush === 'function') res.flush();

  // Heartbeat: comentário SSE a cada 8s pra manter conexão viva
  // mesmo se a IA estiver "pensando" sem produzir tokens.
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
      if (typeof res.flush === 'function') res.flush();
    } catch {}
  }, 8_000);

  const transcriptsBlock = buildTranscriptsBlock(transcripts);
  const startedAt = Date.now();

  // ─── DIFF strategy: extrai textos editáveis do HTML base ───
  // Ao invés da IA reescrever 25k tokens de HTML, ela retorna
  // só o JSON de mudanças. Isso é ~10x mais rápido e barato.
  let baseHtmlWithIds, baseTexts;
  let sourceHtml = isRefinement ? currentHtml : baseHtml;
  try {
    const extracted = extractEditableTexts(sourceHtml);
    baseHtmlWithIds = extracted.html;
    baseTexts = extracted.texts;
  } catch (e) {
    console.error('[api] erro extraindo textos:', e?.message);
    sseSend(res, { type: 'error', error: 'Erro processando template.' });
    clearInterval(heartbeat);
    try { res.end(); } catch {}
    return;
  }

  const textsJson = JSON.stringify(baseTexts, null, 2);
  const numTexts = Object.keys(baseTexts).length;

  // Avisa o cliente que começou (e força mais um flush)
  sseSend(res, { type: 'start', isRefinement, numTexts });
  if (typeof res.flush === 'function') res.flush();

  let messageRequest;
  if (isRefinement) {
    messageRequest = {
      model: ANTHROPIC_MODEL,
      max_tokens: 4_000,
      system: [
        { type: 'text', text: SYSTEM_PROMPT_REFINE },
        {
          type: 'text',
          text: `CONTEXTO DO CLIENTE:\nNome: ${clientName}\n\nTRANSCRIÇÃO ORIGINAL DA REUNIÃO:\n\n${transcriptsBlock}`,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: `TEXTOS ATUAIS DA PROPOSTA (JSON, ${numTexts} itens):\n\n${textsJson}\n\n---\n\nINSTRUÇÃO DE REFINAMENTO DO USUÁRIO:\n${refinement}\n\nRetorne SOMENTE um JSON com os IDs cujos textos você alterou (não inclua IDs sem mudança).`,
        },
      ],
    };
  } else {
    messageRequest = {
      model: ANTHROPIC_MODEL,
      max_tokens: 12_000,
      system: [
        { type: 'text', text: SYSTEM_PROMPT_GENERATE },
        {
          type: 'text',
          text: `TEXTOS ORIGINAIS DA PROPOSTA (JSON com ${numTexts} itens — IDs estáveis):\n\n${textsJson}`,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: `CLIENTE: ${clientName}\n\nTRANSCRIÇÕES DA REUNIÃO DE VENDAS:\n\n${transcriptsBlock}\n\n---\n\nPersonalize a proposta para ${clientName}. Retorne SOMENTE um JSON com os IDs cujos textos você quer alterar (omita os que ficam iguais). Lembre-se: substitua menções a Digital Aligner / Luma / Haira pelo nome ${clientName}.`,
        },
      ],
    };
  }

  let fullText = '';
  let charsSent = 0;
  let finalUsage = null;

  let streamError = null;
  try {
    const stream = anthropic.messages.stream(messageRequest);

    // Event: cada delta de texto
    stream.on('text', (text) => {
      fullText += text;
      // Notifica progresso a cada ~300 chars (output total agora é ~3-8KB)
      if (fullText.length - charsSent >= 300) {
        charsSent = fullText.length;
        try {
          sseSend(res, { type: 'progress', chars: charsSent });
          if (typeof res.flush === 'function') res.flush();
        } catch {}
      }
    });

    // Captura erros que possam ocorrer no stream
    stream.on('error', (err) => {
      streamError = err;
      console.error('[api] stream error event:', err?.message || err);
    });

    // Avisa quando o stream realmente começa a receber a primeira mensagem
    stream.on('connect', () => {
      try {
        sseSend(res, { type: 'connected' });
        if (typeof res.flush === 'function') res.flush();
      } catch {}
    });

    // Aguarda mensagem final completa
    const finalMessage = await stream.finalMessage();
    finalUsage = finalMessage.usage;
    if (streamError) throw streamError;

    const patches = extractJson(fullText);
    const elapsed = Date.now() - startedAt;

    if (!patches || typeof patches !== 'object') {
      console.error('[api] IA retornou JSON inválido. Primeiros 300 chars:', fullText.slice(0, 300));
      sseSend(res, {
        type: 'error',
        error: 'A IA retornou conteúdo inválido. Tente novamente.',
      });
    } else {
      // Aplica patches no HTML base (com data-edit-ids)
      let { html: finalHtml, applied } = applyPatches(baseHtmlWithIds, patches, clientName);

      // ── AUDIT PASS: detecta e corrige leaks do template ────
      // Em gerações iniciais (não refinamento) é comum a IA deixar
      // passar termos do segmento original (dentista, alinhador, etc.).
      // Aqui scaneamos o HTML pós-patch, e se houver leaks, fazemos
      // uma segunda chamada à IA forçando o fix dos IDs afetados.
      let leakFixed = 0;
      let leakUsage = null;
      let leakIds = 0;
      if (!isRefinement) {
        const leakTerms = TEMPLATE_LEAK_TERMS[proposalType] || [];
        const leaks = findLeakIds(finalHtml, leakTerms);
        leakIds = Object.keys(leaks).length;
        if (leakIds > 0) {
          try {
            sseSend(res, { type: 'progress', chars: charsSent, audit: true, leakCount: leakIds });
            if (typeof res.flush === 'function') res.flush();
            const fix = await callAIForLeakFix({
              leaks,
              terms: leakTerms,
              clientName,
              transcriptsBlock,
            });
            const applied2 = applyPatches(finalHtml, fix.patches, clientName);
            finalHtml = applied2.html;
            leakFixed = applied2.applied;
            leakUsage = fix.usage;
          } catch (auditErr) {
            console.error('[api] audit pass falhou (ignorando):', auditErr?.message);
          }
        }
      }
      const elapsedTotal = Date.now() - startedAt;

      console.log(`[api] OK ${isRefinement ? 'refine' : 'generate'} — type ${proposalType}, ${elapsedTotal}ms total, ${numTexts} texts → ${applied} patches + ${leakFixed} leak-fixes (${leakIds} ids), input ${finalUsage?.input_tokens}t (cached: ${finalUsage?.cache_read_input_tokens || 0}t), output ${finalUsage?.output_tokens}t${leakUsage ? `, audit input ${leakUsage.input_tokens}t output ${leakUsage.output_tokens}t` : ''}`);
      sseSend(res, {
        type: 'done',
        html: finalHtml,
        meta: {
          model: ANTHROPIC_MODEL,
          elapsedMs: elapsedTotal,
          transcripts: transcripts.length,
          isRefinement,
          numTexts,
          patchesApplied: applied,
          leakIdsFound: leakIds,
          leakFixed,
          usage: finalUsage,
          auditUsage: leakUsage,
        },
      });
    }
  } catch (e) {
    console.error('[api] erro durante stream:', e?.message || e);
    const msg = e?.message?.includes('rate') ? 'Limite de taxa da API atingido. Aguarde e tente novamente.'
              : e?.message?.includes('overloaded') ? 'A IA está sobrecarregada. Tente novamente em alguns segundos.'
              : e?.message?.includes('authentication') || e?.message?.includes('api_key') ? 'API key da Anthropic inválida ou sem permissão. Verifique no Render.'
              : e?.message?.includes('credit') || e?.message?.includes('balance') ? 'Conta Anthropic sem créditos. Recarregue em console.anthropic.com.'
              : `Erro ao chamar a IA: ${e?.message || 'desconhecido'}`;
    try {
      sseSend(res, { type: 'error', error: msg });
    } catch {}
  } finally {
    clearInterval(heartbeat);
    try { res.end(); } catch {}
  }
});

// ── Estáticos (depois das rotas /api) ───────────────────
// Serve TUDO da raiz do projeto, igual o http-server fazia.
// cache: false → ETag-based, evita cache agressivo durante desenvolvimento.
app.use(express.static(__dirname, {
  index: 'index.html',
  etag: true,
  lastModified: true,
  // Cache moderado pra assets, sem cache pro index.
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=300');
    }
  },
}));

// Fallback final: 404 com JSON pra rotas /api/* não-mapeadas;
// HTML 404 simples pra qualquer outra coisa.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ ok: false, error: 'Endpoint não encontrado.' });
  }
  res.status(404).type('html').send('<!DOCTYPE html><html><body style="font-family:system-ui;padding:40px;background:#07070f;color:#e6e8f2"><h1>404</h1><p>Recurso não encontrado.</p><a href="/" style="color:#9b6dff">Voltar</a></body></html>');
});

// ── Start ───────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('───────────────────────────────────────');
  console.log(`  Jornada Online — server up on :${PORT}`);
  console.log(`  AI mode: ${HAS_AI ? `LIVE (${ANTHROPIC_MODEL})` : 'MOCK (sem ANTHROPIC_API_KEY)'}`);
  console.log('───────────────────────────────────────');
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`[server] received ${signal}, shutting down...`);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
