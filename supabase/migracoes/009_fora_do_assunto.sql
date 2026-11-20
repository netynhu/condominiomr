-- Trava para quem insiste em assuntos que não são do condomínio.
-- Na terceira pergunta fora do assunto (em 24h), o assistente pausa o atendimento daquele número por 12 horas.
-- Rode no SQL Editor do Supabase (pode rodar mais de uma vez).
alter table moradores add column if not exists fora_assunto_vezes int not null default 0;
alter table moradores add column if not exists fora_assunto_em timestamptz;
alter table moradores add column if not exists bloqueado_ate timestamptz;
notify pgrst, 'reload schema';
