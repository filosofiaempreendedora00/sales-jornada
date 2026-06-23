-- ══════════════════════════════════════════════════════════
-- 003 — Kanban de Melhorias agora tem 4 colunas:
--   BACKLOG · TO DO · DOING · COMPLETE
-- O status 'backlog' é novo; os demais reaproveitam os valores
-- existentes (pendente=TO DO, em_andamento=DOING, concluido=COMPLETE).
-- Relaxa o CHECK antigo (que só permitia 3 status) pra aceitar 'backlog'.
-- ══════════════════════════════════════════════════════════
ALTER TABLE melhorias DROP CONSTRAINT IF EXISTS melhorias_status_check;
ALTER TABLE melhorias ADD CONSTRAINT melhorias_status_check
  CHECK (status IN ('backlog', 'pendente', 'em_andamento', 'concluido'));
