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

const SYSTEM_PROMPT_GENERATE = `Você é um copywriter sênior especialista em propostas comerciais B2B da Turbo Partners.

Sua tarefa: receber uma transcrição (ou várias) de reunião de vendas + um template HTML de proposta comercial, e produzir uma nova versão do HTML adaptando a copy para refletir o cliente específico baseado no que foi conversado.

REGRAS RÍGIDAS:
1. Mantenha TODA a estrutura HTML, classes CSS, scripts, IDs, atributos e ordem das seções. Não remova nem adicione seções, divs ou elementos.
2. Mantenha todos os ícones, SVGs, gráficos interativos e blocos visuais como estão.
3. Mantenha os preços, tabelas de investimento e valores do template a menos que o cliente claramente sinalize um budget diferente OU peça especificamente.
4. Mantenha URLs externos, links e referências técnicas.
5. ALTERE apenas conteúdo textual relevante: nome do cliente, indústria/segmento, dores específicas mencionadas, referências citadas pelo cliente, tom de voz, e adaptações de copy que façam a proposta soar específica para ele.
6. SEMPRE substitua o nome do cliente original do template (Digital Aligner / Luma / Haira / etc.) pelo nome real do cliente fornecido. Isso inclui o <title>, headings, parágrafos, navegação, qualquer lugar onde apareça.
7. Quando o cliente cita empresas como referência (Nubank, iFood, etc.), incorpore essas referências sutilmente nos textos relevantes.
8. Quando o cliente menciona dores específicas (CAC alto, churn, baixa retenção), faça as headlines, parágrafos e diferenciais ressoarem com essas dores.
9. Preserve o tom premium e profissional do template — não fique informal demais nem "vendedor".
10. Se a transcrição estiver vazia em informações relevantes, faça mudanças mínimas (mas SEMPRE atualize o nome do cliente).

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

  // Avisa o cliente que começou (e força mais um flush)
  sseSend(res, { type: 'start', isRefinement });
  if (typeof res.flush === 'function') res.flush();

  let messageRequest;
  if (isRefinement) {
    messageRequest = {
      model: ANTHROPIC_MODEL,
      max_tokens: 32_000,
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
          content: `PROPOSTA ATUAL (HTML):\n\n${currentHtml}\n\n---\n\nINSTRUÇÃO DE REFINAMENTO:\n${refinement}\n\nRetorne o HTML completo modificado.`,
        },
      ],
    };
  } else {
    messageRequest = {
      model: ANTHROPIC_MODEL,
      max_tokens: 32_000,
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
          content: `CLIENTE: ${clientName}\n\nTRANSCRIÇÕES DA REUNIÃO DE VENDAS:\n\n${transcriptsBlock}\n\n---\n\nGere a proposta personalizada para ${clientName} com base no que foi conversado. Substitua nomes de clientes do template (Digital Aligner / Luma / Haira) pelo nome do cliente real (${clientName}).`,
        },
      ],
    };
  }

  let fullText = '';
  let charsSent = 0;
  let finalUsage = null;

  try {
    const stream = anthropic.messages.stream(messageRequest);

    // Event: cada delta de texto
    stream.on('text', (text) => {
      fullText += text;
      // Notifica progresso a cada ~500 chars pra não inundar o cliente
      if (fullText.length - charsSent >= 500) {
        charsSent = fullText.length;
        try {
          sseSend(res, { type: 'progress', chars: charsSent });
          if (typeof res.flush === 'function') res.flush();
        } catch {}
      }
    });

    // Aguarda mensagem final completa
    const finalMessage = await stream.finalMessage();
    finalUsage = finalMessage.usage;

    const html = sanitizeAIHtml(fullText);
    const elapsed = Date.now() - startedAt;

    if (!html) {
      console.error('[api] AI retornou HTML inválido. Primeiros 300 chars:', fullText.slice(0, 300));
      sseSend(res, {
        type: 'error',
        error: 'A IA retornou conteúdo inválido. Tente novamente ou ajuste a transcrição.',
      });
    } else {
      console.log(`[api] OK ${isRefinement ? 'refine' : 'generate'} — proposal ${proposalType}, ${elapsed}ms, input ${finalUsage?.input_tokens}t (cached: ${finalUsage?.cache_read_input_tokens || 0}t), output ${finalUsage?.output_tokens}t`);
      sseSend(res, {
        type: 'done',
        html,
        meta: {
          model: ANTHROPIC_MODEL,
          elapsedMs: elapsed,
          transcripts: transcripts.length,
          isRefinement,
          usage: finalUsage,
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
