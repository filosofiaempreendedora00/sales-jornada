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
const REQUEST_TIMEOUT_MS = 120_000;   // 2 min — gerações podem demorar

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
  });
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
  const refinement = typeof body.refinement === 'string' ? body.refinement.trim() : '';
  if (refinement.length > MAX_REFINEMENT_CHARS) {
    errors.push(`Instrução de refinamento muito longa (limite: ${MAX_REFINEMENT_CHARS} chars).`);
  }
  const currentHtml = typeof body.currentHtml === 'string' ? body.currentHtml : '';
  return { errors, transcripts, proposalType, refinement, currentHtml };
}

async function loadTemplate(proposalType) {
  const file = PROPOSAL_FILES[proposalType];
  if (!file) throw new Error('Tipo inválido');
  const filePath = path.join(__dirname, file);
  return await readFile(filePath, 'utf8');
}

const SYSTEM_PROMPT_GENERATE = `Você é um copywriter sênior especialista em propostas comerciais B2B da Turbo Partners.

Sua tarefa: receber uma transcrição (ou várias) de reunião de vendas + um template HTML de proposta comercial, e produzir uma nova versão do HTML adaptando a copy para refletir o cliente específico baseado no que foi conversado.

REGRAS RÍGIDAS:
1. Mantenha TODA a estrutura HTML, classes CSS, scripts, IDs, atributos e ordem das seções. Não remova nem adicione seções, divs ou elementos.
2. Mantenha todos os ícones, SVGs, gráficos interativos e blocos visuais como estão.
3. Mantenha os preços, tabelas de investimento e valores do template a menos que o cliente claramente sinalize um budget diferente OU peça especificamente.
4. Mantenha URLs externos, links e referências técnicas.
5. ALTERE apenas conteúdo textual relevante: nome do cliente, indústria/segmento, dores específicas mencionadas, referências citadas pelo cliente, tom de voz, e adaptações de copy que façam a proposta soar específica para ele.
6. Quando o cliente cita empresas como referência (Nubank, iFood, etc.), incorpore essas referências sutilmente nos textos relevantes.
7. Quando o cliente menciona dores específicas (CAC alto, churn, baixa retenção), faça as headlines, parágrafos e diferenciais ressoarem com essas dores.
8. Preserve o tom premium e profissional do template — não fique informal demais nem "vendedor".
9. Se a transcrição estiver vazia em informações relevantes, faça mudanças mínimas (só nome do cliente se mencionado).

FORMATO DE RESPOSTA:
- Retorne APENAS o HTML completo modificado, começando com <!DOCTYPE html> e terminando com </html>.
- NÃO envolva em \`\`\`html ou qualquer markdown.
- NÃO inclua comentários, explicações, prefácios ou epílogos.
- O output deve ser HTML válido que pode ser servido direto.`;

const SYSTEM_PROMPT_REFINE = `Você está refinando uma proposta comercial B2B da Turbo Partners que já foi gerada para um cliente específico.

Sua tarefa: receber a transcrição original da reunião + a versão atual da proposta (HTML) + uma instrução de refinamento do usuário, e aplicar APENAS a mudança solicitada.

REGRAS:
1. Aplique EXATAMENTE o que foi pedido na instrução, nada mais.
2. Mantenha tudo o resto da proposta intacto — estrutura, classes, IDs, outros textos, preços (a menos que a instrução seja sobre eles), seções.
3. Se a instrução for ambígua, faça a interpretação mais conservadora.
4. Preserve o tom premium e profissional.

FORMATO DE RESPOSTA:
- Retorne APENAS o HTML completo modificado, começando com <!DOCTYPE html> e terminando com </html>.
- NÃO envolva em \`\`\`html ou qualquer markdown.
- NÃO inclua comentários, explicações, prefácios ou epílogos.`;

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

// ── Endpoint: GERAR / REFINAR proposta ──────────────────
app.post('/api/generate-proposal', async (req, res) => {
  // Set timeout pra não pendurar resposta indefinidamente
  req.setTimeout(REQUEST_TIMEOUT_MS);
  res.setTimeout(REQUEST_TIMEOUT_MS);

  const { errors, transcripts, proposalType, refinement, currentHtml } =
    validateGenerateInput(req.body || {});

  if (errors.length) {
    return res.status(400).json({ ok: false, error: errors.join(' ') });
  }

  // Decidir modo: gerar do zero ou refinar.
  const isRefinement = refinement.length > 0 && currentHtml.length > 0;

  try {
    let baseHtml;
    try {
      baseHtml = await loadTemplate(proposalType);
    } catch (e) {
      console.error('[api] erro lendo template', proposalType, e);
      return res.status(500).json({ ok: false, error: 'Template não encontrado.' });
    }

    // ── MODO MOCK (sem API key) ────────────────────────
    if (!HAS_AI) {
      console.log(`[api] MOCK ${isRefinement ? 'refine' : 'generate'} — proposal ${proposalType}, transcripts: ${transcripts.length}, refinement: ${refinement.length} chars`);
      // Retorna o template (ou currentHtml se for refinement) sem mudanças,
      // adicionando um banner discreto pra deixar claro que é mock.
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

    // ── MODO LIVE (Anthropic) ───────────────────────────
    const transcriptsBlock = buildTranscriptsBlock(transcripts);
    const startedAt = Date.now();

    let response;
    if (isRefinement) {
      // Refinamento: cache da transcrição (varia pouco entre refinos),
      // o usuário só muda a instrução e o HTML atual.
      response = await anthropic.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 64_000,
        system: [
          { type: 'text', text: SYSTEM_PROMPT_REFINE },
          {
            type: 'text',
            text: `TRANSCRIÇÃO ORIGINAL DA REUNIÃO (para contexto):\n\n${transcriptsBlock}`,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [
          {
            role: 'user',
            content: `PROPOSTA ATUAL (HTML):\n\n${currentHtml}\n\n---\n\nINSTRUÇÃO DE REFINAMENTO:\n${refinement}\n\nRetorne o HTML completo modificado.`,
          },
        ],
      });
    } else {
      // Geração: cache do template (mesmo template em múltiplas gerações
      // da mesma jornada/cliente).
      response = await anthropic.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 64_000,
        system: [
          { type: 'text', text: SYSTEM_PROMPT_GENERATE },
          {
            type: 'text',
            text: `TEMPLATE HTML DA PROPOSTA (use como base — mantenha estrutura, altere copy):\n\n${baseHtml}`,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [
          {
            role: 'user',
            content: `TRANSCRIÇÕES DA REUNIÃO DE VENDAS:\n\n${transcriptsBlock}\n\n---\n\nGere a proposta personalizada para este cliente com base no que foi conversado.`,
          },
        ],
      });
    }

    const elapsed = Date.now() - startedAt;
    const text = response?.content?.[0]?.text || '';
    const html = sanitizeAIHtml(text);

    if (!html) {
      console.error('[api] AI retornou HTML inválido. Primeiros 300 chars:', text.slice(0, 300));
      return res.status(502).json({
        ok: false,
        error: 'A IA retornou conteúdo inválido. Tente novamente ou ajuste a transcrição.',
      });
    }

    console.log(`[api] OK ${isRefinement ? 'refine' : 'generate'} — proposal ${proposalType}, ${elapsed}ms, input ${response.usage?.input_tokens}t (cached: ${response.usage?.cache_read_input_tokens || 0}t), output ${response.usage?.output_tokens}t`);

    return res.json({
      ok: true,
      mode: 'live',
      html,
      meta: {
        model: ANTHROPIC_MODEL,
        elapsedMs: elapsed,
        transcripts: transcripts.length,
        isRefinement,
        usage: response.usage,
      },
    });
  } catch (e) {
    console.error('[api] erro inesperado:', e?.message || e);
    // NÃO vazar stack trace pro cliente.
    const status = e?.status >= 400 && e?.status < 600 ? e.status : 500;
    return res.status(status).json({
      ok: false,
      error: e?.message?.includes('rate') ? 'Limite de taxa da API atingido. Aguarde e tente novamente.'
           : e?.message?.includes('overloaded') ? 'A IA está sobrecarregada. Tente novamente em alguns segundos.'
           : 'Erro inesperado ao gerar a proposta. Tente novamente.',
    });
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
