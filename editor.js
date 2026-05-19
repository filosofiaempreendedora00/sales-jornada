/*
  editor.js — Modo edição injetado no iframe das propostas geradas.

  Responsabilidades:
  1. Marcar textos (h1-h6, p, li, spans) como contenteditable
  2. Marcar valores de preço/dinheiro como editáveis (mas excluir totais
     computados, marcados via data-no-edit ou IDs conhecidos)
  3. Adicionar drag handles em cada <section> direta de <main>/<body>
     pra reorder, com Sortable.js (touch-friendly)
  4. Expor uma função window.__exportClean() que serializa o documento
     SEM os artefatos do edit mode (sem outlines, sem handles, sem
     contenteditable). É o que o botão "Baixar HTML" usa.

  Tudo o que esse script adiciona pode (e deve) ser removido na hora
  de exportar — é UI/UX que só faz sentido no preview do app.
*/
(function () {
  'use strict';

  const NS = '__sm_edit'; // namespace pra todos os marcadores

  // ── Elementos que não devem ser editáveis (tier-controlled, totais) ──
  // Por ID (programaticamente atualizados por JS no template).
  const FORBIDDEN_IDS = new Set([
    // proposta-performance-mql.html
    'perf-creatives',
    'perf-price',
    'perf-budget',
    'bundle-perf-price',
    'bundle-perf-budget',
    'bundle-total',
    // proposta-reguas.html
    'inv-tier-price',
    'inv-item-tier',
    'proj-pay-note',
    'proj-tier-note',
    'proj-legend-rec',
    'proj-legend-ins',
    'proj-total',
  ]);

  // Por classe — qualquer elemento com esses identifiers fica fora.
  const FORBIDDEN_CLASS_RE = /\b(?:no-edit|sm-pricing-divider|prop-bar-rec|prop-bar-ins|proj-bar-stack|proj-bar-rec|proj-bar-ins|proj-bar-label)\b/;

  // Elementos que NÃO viram editáveis (estrutura, controles, SVG).
  const NEVER_EDITABLE_TAGS = new Set([
    'SVG', 'PATH', 'CIRCLE', 'POLYLINE', 'RECT', 'POLYGON', 'LINE', 'G', 'USE',
    'BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'SCRIPT', 'STYLE',
    'NAV', 'IMG', 'VIDEO', 'IFRAME', 'CANVAS',
  ]);

  // Elementos cujo TEXTO direto deve virar editável.
  const EDITABLE_TAGS = new Set([
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'P', 'LI',
    'SPAN', // muitos preços/badges são span
    'DIV',  // muitos labels de número são div
  ]);

  function isForbidden(el) {
    if (NEVER_EDITABLE_TAGS.has(el.tagName)) return true;
    if (el.id && FORBIDDEN_IDS.has(el.id)) return true;
    if (el.className && typeof el.className === 'string' && FORBIDDEN_CLASS_RE.test(el.className)) return true;
    if (el.dataset && el.dataset.noEdit) return true;
    // Não-editar se está dentro de <nav> ou <button> ou <a>
    if (el.closest && (el.closest('nav') || el.closest('button') || el.closest('a'))) return true;
    return false;
  }

  // Considera "leaf text element": tem só nós de texto (ou só inline simples).
  function isLeafText(el) {
    if (!EDITABLE_TAGS.has(el.tagName)) return false;
    // Tem que ter algum texto
    const text = (el.textContent || '').trim();
    if (text.length === 0) return false;
    // Se todos os filhos são nodes de texto OU inline simples (strong/em/i/b/span),
    // consideramos leaf.
    for (const child of el.childNodes) {
      if (child.nodeType === 3) continue; // texto
      if (child.nodeType !== 1) continue;
      const tag = child.tagName;
      // Aceita inline genuíno; rejeita qualquer elemento "container" com filhos próprios
      if (!['STRONG','EM','I','B','SMALL','BR','U','MARK','BR','SUP','SUB'].includes(tag)) {
        return false;
      }
    }
    return true;
  }

  // ── 1) Marca contenteditable ────────────────────────────────────
  function markEditable(root) {
    const all = root.querySelectorAll(Array.from(EDITABLE_TAGS).join(','));
    let count = 0;
    all.forEach(el => {
      if (isForbidden(el)) return;
      if (!isLeafText(el)) return;
      // Já dentro de outro contenteditable? pula
      if (el.parentElement && el.parentElement.closest('[contenteditable="true"]')) return;
      el.setAttribute('contenteditable', 'plaintext-only');
      el.setAttribute('spellcheck', 'false');
      el.classList.add(NS + '-editable');
      count++;
    });
    return count;
  }

  // ── 2) Adiciona drag handles + Sortable ─────────────────────────
  function setupSortable(doc) {
    // Container de sections: <main> se existir, senão <body>
    const container = doc.querySelector('main') || doc.body;
    const sections = container.querySelectorAll(':scope > section');
    if (sections.length < 2) return false;

    sections.forEach((section, idx) => {
      // Garante position relative pro handle absolute
      const cs = doc.defaultView.getComputedStyle(section);
      if (cs.position === 'static') {
        section.style.position = 'relative';
      }
      // Não adiciona handle duplicado
      if (section.querySelector('.' + NS + '-handle')) return;
      const handle = doc.createElement('button');
      handle.type = 'button';
      handle.className = NS + '-handle';
      handle.setAttribute('aria-label', 'Arrastar seção');
      handle.setAttribute('title', 'Arrastar para reordenar');
      handle.contentEditable = 'false';
      handle.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
        '<circle cx="9" cy="6" r="1.5" fill="currentColor"/>' +
        '<circle cx="15" cy="6" r="1.5" fill="currentColor"/>' +
        '<circle cx="9" cy="12" r="1.5" fill="currentColor"/>' +
        '<circle cx="15" cy="12" r="1.5" fill="currentColor"/>' +
        '<circle cx="9" cy="18" r="1.5" fill="currentColor"/>' +
        '<circle cx="15" cy="18" r="1.5" fill="currentColor"/>' +
        '</svg>';
      section.prepend(handle);
    });

    const win = doc.defaultView;
    if (!win.Sortable) return false;

    new win.Sortable(container, {
      animation: 240,
      handle: '.' + NS + '-handle',
      draggable: 'section',
      ghostClass: NS + '-ghost',
      chosenClass: NS + '-chosen',
      dragClass: NS + '-drag',
      forceFallback: false,
      // Suporta touch nativamente
      touchStartThreshold: 6,
      delay: 0,
    });
    return true;
  }

  // ── 3) Injeta estilos do edit mode ──────────────────────────────
  function injectStyles(doc) {
    if (doc.getElementById(NS + '-style')) return;
    const style = doc.createElement('style');
    style.id = NS + '-style';
    style.textContent = `
      /* ─── Edit mode styles (REMOVIDOS no export) ─── */
      .${NS}-editable {
        outline: 1px dashed transparent;
        outline-offset: 3px;
        border-radius: 3px;
        transition: outline-color 0.15s, background 0.15s;
        cursor: text;
      }
      .${NS}-editable:hover {
        outline-color: rgba(155, 109, 255, 0.45);
      }
      .${NS}-editable:focus {
        outline: 1px solid rgba(155, 109, 255, 0.75);
        background: rgba(155, 109, 255, 0.05);
        outline-offset: 4px;
      }

      .${NS}-handle {
        position: absolute;
        top: 12px;
        right: 12px;
        width: 32px;
        height: 32px;
        border: 1px dashed rgba(155, 109, 255, 0.45);
        background: rgba(20, 18, 40, 0.85);
        backdrop-filter: blur(6px);
        color: rgba(196, 168, 255, 0.85);
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: grab;
        z-index: 999;
        opacity: 0;
        transform: translateY(-2px);
        transition: opacity 0.18s ease, transform 0.18s ease, background 0.15s, border-color 0.15s;
        padding: 0;
        font-family: inherit;
      }
      section:hover > .${NS}-handle,
      .${NS}-handle:focus {
        opacity: 1;
        transform: translateY(0);
      }
      .${NS}-handle:hover {
        background: rgba(155, 109, 255, 0.18);
        border-color: rgba(155, 109, 255, 0.7);
        color: #d8c4ff;
      }
      .${NS}-handle:active { cursor: grabbing; }

      .${NS}-ghost {
        opacity: 0.35;
      }
      .${NS}-chosen {
        box-shadow: 0 0 0 1px rgba(155, 109, 255, 0.5), 0 16px 48px rgba(0,0,0,0.45);
      }
      .${NS}-drag {
        cursor: grabbing !important;
      }

      /* Banner discreto no topo do iframe explicando o edit mode */
      #${NS}-banner {
        position: fixed;
        top: 12px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 9999;
        display: inline-flex;
        align-items: center;
        gap: 10px;
        background: rgba(20, 18, 40, 0.88);
        backdrop-filter: blur(10px);
        border: 1px solid rgba(155, 109, 255, 0.35);
        color: #c4a8ff;
        font-family: -apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.2px;
        padding: 6px 14px;
        border-radius: 99px;
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
        pointer-events: none;
        opacity: 0;
        animation: ${NS}-banner-in 0.4s 0.6s ease forwards, ${NS}-banner-out 0.6s 6s ease forwards;
      }
      #${NS}-banner-dot {
        width: 6px; height: 6px;
        border-radius: 50%;
        background: #9b6dff;
        box-shadow: 0 0 8px #9b6dff;
        animation: ${NS}-pulse 2s ease infinite;
      }
      @keyframes ${NS}-banner-in {
        from { opacity: 0; transform: translateX(-50%) translateY(-6px); }
        to   { opacity: 1; transform: translateX(-50%) translateY(0); }
      }
      @keyframes ${NS}-banner-out {
        from { opacity: 1; }
        to   { opacity: 0; transform: translateX(-50%) translateY(-6px); }
      }
      @keyframes ${NS}-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }

      /* Floating Action Button — Baixar HTML editado */
      #${NS}-fab {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 9998;
        display: inline-flex;
        align-items: center;
        gap: 10px;
        background: linear-gradient(135deg, #12d490, #0dcfe8);
        color: #07070f;
        border: 0;
        border-radius: 99px;
        padding: 14px 22px;
        font-family: -apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif;
        font-size: 14px;
        font-weight: 700;
        letter-spacing: 0.2px;
        cursor: pointer;
        box-shadow:
          0 8px 28px rgba(18, 212, 144, 0.35),
          0 0 0 1px rgba(255,255,255,0.08) inset;
        transition: transform 0.2s ease, box-shadow 0.2s ease, filter 0.2s ease;
      }
      #${NS}-fab:hover {
        transform: translateY(-2px);
        filter: brightness(1.06);
        box-shadow:
          0 12px 36px rgba(18, 212, 144, 0.45),
          0 0 0 1px rgba(255,255,255,0.12) inset;
      }
      #${NS}-fab:active { transform: translateY(0); }
      #${NS}-fab svg { flex-shrink: 0; }
    `;
    doc.head.appendChild(style);
  }

  function injectBanner(doc) {
    if (doc.getElementById(NS + '-banner')) return;
    const banner = doc.createElement('div');
    banner.id = NS + '-banner';
    banner.contentEditable = 'false';
    banner.innerHTML =
      '<span id="' + NS + '-banner-dot"></span>' +
      'Modo edição — clique nos textos pra editar · arraste o ⋮⋮ pra reordenar';
    doc.body.appendChild(banner);
  }

  // Botão flutuante de download — sempre visível no canto inferior direito
  // do iframe. Quando clicado, chama a função do parent que sabe o
  // contexto (cliente, tipo, data) e dispara o download.
  function injectDownloadFab(doc) {
    if (doc.getElementById(NS + '-fab')) return;
    const fab = doc.createElement('button');
    fab.type = 'button';
    fab.id = NS + '-fab';
    fab.contentEditable = 'false';
    fab.setAttribute('aria-label', 'Baixar proposta editada');
    fab.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">' +
      '<path d="M12 4v12m0 0l-5-5m5 5l5-5M5 20h14"/></svg>' +
      '<span>Baixar HTML editado</span>';
    fab.addEventListener('click', () => {
      try {
        if (window.parent && typeof window.parent.__smRequestDownload === 'function') {
          window.parent.__smRequestDownload();
        }
      } catch (e) {
        console.error('[edit] download falhou:', e);
      }
    });
    doc.body.appendChild(fab);
  }

  // ── 4) Export limpo ────────────────────────────────────────────
  function exportCleanHTML(doc) {
    // Clona o document inteiro pra não mexer no atual
    const cloneDoc = doc.cloneNode(true);

    // Remove style block do edit mode
    const styleNode = cloneDoc.getElementById(NS + '-style');
    if (styleNode) styleNode.remove();

    // Remove banner
    const banner = cloneDoc.getElementById(NS + '-banner');
    if (banner) banner.remove();

    // Remove floating download button
    const fab = cloneDoc.getElementById(NS + '-fab');
    if (fab) fab.remove();

    // Remove drag handles
    cloneDoc.querySelectorAll('.' + NS + '-handle').forEach(el => el.remove());

    // Remove o script editor.js (se foi adicionado) e sortable
    cloneDoc.querySelectorAll('script[data-' + NS + ']').forEach(el => el.remove());

    // Remove contenteditable attributes e classes
    cloneDoc.querySelectorAll('[contenteditable]').forEach(el => {
      el.removeAttribute('contenteditable');
      el.removeAttribute('spellcheck');
      el.classList.remove(NS + '-editable');
      // Limpa atributo class se ficou vazio
      if (el.classList.length === 0) el.removeAttribute('class');
    });

    // Limpa style="position: relative" que adicionamos no section
    // (só remove se for exatamente esse — preserva styles existentes)
    cloneDoc.querySelectorAll('section[style]').forEach(el => {
      const s = el.getAttribute('style').trim();
      if (s === 'position: relative;' || s === 'position:relative;') {
        el.removeAttribute('style');
      } else {
        // Tira só a regra
        const cleaned = s.replace(/position\s*:\s*relative\s*;?\s*/i, '').trim();
        if (cleaned) el.setAttribute('style', cleaned);
        else el.removeAttribute('style');
      }
    });

    // Serializa
    const html = '<!DOCTYPE html>\n' + cloneDoc.documentElement.outerHTML;
    return html;
  }

  // ── Boot ────────────────────────────────────────────────────────
  function boot() {
    const doc = document;
    if (!doc.body) {
      // Tenta novamente
      window.addEventListener('DOMContentLoaded', boot, { once: true });
      return;
    }
    injectStyles(doc);
    const editableCount = markEditable(doc.body);
    const sortableOK = setupSortable(doc);
    injectBanner(doc);
    injectDownloadFab(doc);
    // Expor função de export pro parent
    window.__exportClean = () => exportCleanHTML(doc);
    // Sinaliza ao parent que está pronto
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({
          type: NS + ':ready',
          editableCount,
          sortableOK,
        }, '*');
      }
    } catch {}
  }

  // Aguarda Sortable carregar (foi injetado como script tag pelo parent)
  function waitForSortableThenBoot(retries = 40) {
    if (window.Sortable || retries <= 0) {
      boot();
      return;
    }
    setTimeout(() => waitForSortableThenBoot(retries - 1), 50);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => waitForSortableThenBoot());
  } else {
    waitForSortableThenBoot();
  }
})();
