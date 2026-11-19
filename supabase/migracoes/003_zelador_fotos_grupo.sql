-- App do zelador, fotos nos chamados, avaliação do atendimento e avisos no grupo.
-- Rode no SQL Editor do Supabase (pode rodar mais de uma vez sem problema).

-- Fotos e avaliação nos chamados
alter table chamados add column if not exists foto text;              -- id da foto do problema (tabela fotos)
alter table chamados add column if not exists foto_conclusao text;    -- id da foto do serviço pronto
alter table chamados add column if not exists avaliacao int check (avaliacao between 1 and 5);
alter table chamados add column if not exists avaliacao_pedida_em timestamptz;
alter table chamados add column if not exists aberto_por text;        -- nome de quem abriu pelo painel/app

-- Acesso do zelador por link (sem senha)
alter table usuarios add column if not exists token_acesso text unique;

-- Avisos: no grupo (padrão) ou no privado
alter table avisos add column if not exists canal text not null default 'grupo';

-- Controle para não chamar o mesmo morador no privado várias vezes por causa do grupo
alter table moradores add column if not exists abordado_grupo_em timestamptz;

-- Fotos guardadas no próprio banco (já chegam comprimidas, cerca de 200 KB cada)
create table if not exists fotos (
  id uuid primary key default gen_random_uuid(),
  pasta text not null default 'chamados',
  mime text not null default 'image/jpeg',
  dados text not null,                    -- conteúdo em base64
  criado_em timestamptz not null default now()
);
alter table fotos enable row level security;
