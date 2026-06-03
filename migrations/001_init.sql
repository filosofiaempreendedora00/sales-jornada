-- ══════════════════════════════════════════════════════════
-- Schema inicial do Octopus
-- Tabelas: cases (+ solucoes filhas), melhorias, concessoes
-- Texto e nomes em snake_case (padrão Postgres).
-- ══════════════════════════════════════════════════════════

-- Biblioteca de Cases ────────────────────────────────────
CREATE TABLE IF NOT EXISTS cases (
  id              TEXT PRIMARY KEY,
  nicho_id        TEXT NOT NULL,
  subnicho        TEXT NOT NULL,
  nome            TEXT NOT NULL,
  instagram       TEXT,                                   -- handle sem @
  site            TEXT,                                   -- URL com https
  -- Campos descritivos (importados do PDF)
  faturamento_inicial   TEXT,
  faturamento_atual     TEXT,
  ticket_medio          TEXT,
  prazo_evolucao        TEXT,
  trabalho_realizado    TEXT,
  estrategia_aplicada   TEXT,
  observacoes           TEXT,
  -- Metadata
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS cases_nicho_idx ON cases(nicho_id);

-- Soluções dentro de cada Case (1 case → N soluções)
CREATE TABLE IF NOT EXISTS solucoes (
  id            TEXT PRIMARY KEY,
  case_id       TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  sol_cat_id    TEXT,                                     -- ID do catálogo (Performance, Creators...)
  nome          TEXT NOT NULL,
  icon          TEXT,
  stage         TEXT,
  url           TEXT,
  conteudo      TEXT,
  ordem         INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS solucoes_case_idx ON solucoes(case_id);

-- Roadmap pessoal (Configurações → Melhorias) ────────────
CREATE TABLE IF NOT EXISTS melhorias (
  id              TEXT PRIMARY KEY,
  titulo          TEXT NOT NULL,
  descricao       TEXT,
  status          TEXT NOT NULL DEFAULT 'pendente'
                  CHECK (status IN ('pendente', 'em_andamento', 'concluido')),
  prioridade      TEXT NOT NULL DEFAULT 'media'
                  CHECK (prioridade IN ('baixa', 'media', 'alta')),
  data_alvo       DATE,
  imagem          TEXT,                                   -- data URL (base64) ou path
  solicitado_por  TEXT,                                   -- closer ID
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS melhorias_status_idx ON melhorias(status);

-- Concessões (cada doc tem slug único; conteúdo HTML pré-processado) ─
CREATE TABLE IF NOT EXISTS concessoes (
  slug          TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  html          TEXT NOT NULL,
  ordem         INT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger genérico de updated_at ─────────────────────────
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cases_touch ON cases;
CREATE TRIGGER cases_touch BEFORE UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS melhorias_touch ON melhorias;
CREATE TRIGGER melhorias_touch BEFORE UPDATE ON melhorias
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
