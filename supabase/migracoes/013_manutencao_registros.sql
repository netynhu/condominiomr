-- Histórico de manutenções feitas (caixa d'água, elevador, extintores...).
-- O assistente usa para responder "quando foi a última limpeza da caixa d'água?".
-- Rode no SQL Editor do Supabase (pode rodar mais de uma vez).
create table if not exists manutencao_registros (
  id bigserial primary key,
  condominio_id uuid not null references condominios(id) on delete cascade,
  manutencao_id uuid references manutencoes(id) on delete set null,   -- item da manutenção preventiva (se houver)
  titulo text not null,
  feita_em date not null,
  empresa text,                                                        -- empresa ou responsável
  observacao text,
  registrada_por text,
  criado_em timestamptz not null default now()
);
create index if not exists manutencao_registros_idx on manutencao_registros (condominio_id, feita_em desc);
alter table manutencao_registros enable row level security;
notify pgrst, 'reload schema';
