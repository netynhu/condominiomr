-- Importação de documentos em PDF (convenção, regulamento): o navegador manda página por página,
-- o sistema lê (texto ou imagem escaneada), monta o documento do assistente e sugere horários e regras.
-- Rode no SQL Editor do Supabase (pode rodar mais de uma vez).
create table if not exists importacoes (
  id bigserial primary key,
  condominio_id uuid not null references condominios(id) on delete cascade,
  nome text not null,                         -- nome do arquivo
  paginas int not null default 0,
  status text not null default 'enviando' check (status in ('enviando','processando','pronto','erro')),
  erro text,
  sugestoes jsonb,                            -- horários, regras, contradições e páginas técnicas sugeridos pela IA
  documento_id uuid references documentos(id) on delete set null,
  criado_em timestamptz not null default now()
);
create index if not exists importacoes_condominio_idx on importacoes (condominio_id, criado_em desc);
alter table importacoes enable row level security;

create table if not exists importacao_paginas (
  importacao_id bigint not null references importacoes(id) on delete cascade,
  pagina int not null,
  texto text not null default '',
  primary key (importacao_id, pagina)
);
alter table importacao_paginas enable row level security;
notify pgrst, 'reload schema';
