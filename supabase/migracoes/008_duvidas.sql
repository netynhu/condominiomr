-- Dúvidas que o assistente não soube responder. A administração responde no painel (ou pelo WhatsApp),
-- o morador recebe a resposta e, se marcado, o assistente passa a usar essa resposta nas próximas perguntas.
-- Rode no SQL Editor do Supabase (pode rodar mais de uma vez).
create table if not exists duvidas (
  id bigserial primary key,
  morador_id uuid references moradores(id) on delete set null,
  telefone text,
  pergunta text not null,
  contexto text,
  status text not null default 'aberta' check (status in ('aberta','respondida','descartada')),
  resposta text,
  ensinar boolean not null default true,      -- o assistente usa a resposta nas próximas conversas
  respondida_por text,
  criado_em timestamptz not null default now(),
  respondida_em timestamptz
);
create index if not exists duvidas_status_idx on duvidas (status, criado_em desc);
alter table duvidas enable row level security;
notify pgrst, 'reload schema';
