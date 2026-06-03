-- ══════════════════════════════════════════════════════════
-- Correção: os campos descritivos do case no front-end têm nomes
-- diferentes dos que a migration 001 criou. A 001 inventou
-- faturamento_inicial/ticket_medio/etc (que o front nunca usa).
-- Os campos REAIS que o seed + form usam são:
--   funil, site_turbo, operacao, desafios, estrategia,
--   resultados, cliente_local_es
-- Esta migration adiciona as colunas corretas (aditiva — não
-- dropa as antigas pra não arriscar, elas só ficam NULL/sem uso).
-- ══════════════════════════════════════════════════════════

ALTER TABLE cases ADD COLUMN IF NOT EXISTS funil            TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS site_turbo       BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS operacao         TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS desafios         TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS estrategia       TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS resultados       TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS cliente_local_es BOOLEAN NOT NULL DEFAULT FALSE;
