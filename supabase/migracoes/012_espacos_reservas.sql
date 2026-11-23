-- Checklist de espaços: o síndico monta o checklist de cada área (salão, churrasqueira...).
-- A administração cadastra a reserva; o morador recebe no WhatsApp o link do check-in (no início)
-- e do check-out (no fim). O sistema compara os dois e avisa a administração se algo piorou.
-- Rode no SQL Editor do Supabase (pode rodar mais de uma vez).

create table if not exists espacos (
  id uuid primary key default gen_random_uuid(),
  condominio_id uuid not null references condominios(id) on delete cascade,
  nome text not null,
  itens jsonb not null default '[]'::jsonb,   -- [{ "texto": "Churrasqueira limpa", "foto": true }]
  ativo boolean not null default true,
  criado_em timestamptz not null default now()
);
create index if not exists espacos_condominio_idx on espacos (condominio_id);
alter table espacos enable row level security;

create table if not exists reservas (
  id bigserial primary key,
  condominio_id uuid not null references condominios(id) on delete cascade,
  espaco_id uuid not null references espacos(id) on delete cascade,
  morador_id uuid references moradores(id) on delete set null,
  inicio timestamptz not null,
  fim timestamptz not null,
  status text not null default 'agendada' check (status in ('agendada','em_uso','concluida','cancelada')),
  token text not null unique,                 -- link do check-in/check-out (sem senha)
  observacao text,
  criada_por text,
  entrada jsonb,                              -- check-in: [{ texto, ok, obs, foto }]
  entrada_em timestamptz,
  saida jsonb,                                -- check-out
  saida_em timestamptz,
  problemas text,                             -- resumo do que piorou entre a entrada e a saída
  entrada_link_em timestamptz,                -- quando o link do check-in foi enviado
  saida_link_em timestamptz,
  entrada_lembrete_em timestamptz,
  saida_lembrete_em timestamptz,
  administracao_avisada_em timestamptz,       -- aviso de check-in/check-out não feito
  criado_em timestamptz not null default now()
);
create index if not exists reservas_condominio_inicio_idx on reservas (condominio_id, inicio);
alter table reservas enable row level security;

notify pgrst, 'reload schema';
