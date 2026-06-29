-- ══════════════════════════════════════════════════════════
-- 004 — Histórico de gerações de proposta com IA (Configurações → Custos).
-- Cada chamada LIVE ao /api/generate-proposal (gerar OU refinar) registra
-- aqui: data, cliente, tipo de template, tokens e custo em US$. Serve pra o
-- Roberto NUNCA perder de vista o custo acumulado das gerações.
-- ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS generations (
  id                    BIGSERIAL PRIMARY KEY,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  client_name           TEXT,
  proposal_type         TEXT,                       -- '00'..'03'
  kind                  TEXT         NOT NULL DEFAULT 'generate',  -- 'generate' | 'refine'
  model                 TEXT,
  input_tokens          INTEGER      NOT NULL DEFAULT 0,
  output_tokens         INTEGER      NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER      NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER      NOT NULL DEFAULT 0,
  cost_usd              NUMERIC(12,6) NOT NULL DEFAULT 0,
  elapsed_ms            INTEGER      NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS generations_created_at_idx ON generations (created_at DESC);
