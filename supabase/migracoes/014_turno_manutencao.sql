-- Horário de trabalho de cada pessoa da manutenção, por condomínio.
-- Ex.: { "dias": [1,2,3,4,5], "inicio": "08:00", "fim": "17:00" }  (0 = domingo ... 6 = sábado)
-- O síndico escolhe em Ajustes se os chamados vão para todos ou só para quem está no horário.
-- Rode no SQL Editor do Supabase (pode rodar mais de uma vez).
alter table usuario_condominios add column if not exists turno jsonb;
notify pgrst, 'reload schema';
