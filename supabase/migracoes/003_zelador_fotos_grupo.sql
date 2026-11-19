-- App do zelador, fotos nos chamados, avaliação do atendimento e avisos no grupo.
-- Rode no SQL Editor do Supabase (pode rodar mais de uma vez sem problema).

-- Fotos e avaliação nos chamados
alter table chamados add column if not exists foto text;              -- caminho da foto do problema no Storage
alter table chamados add column if not exists foto_conclusao text;    -- foto do serviço pronto
alter table chamados add column if not exists avaliacao int check (avaliacao between 1 and 5);
alter table chamados add column if not exists avaliacao_pedida_em timestamptz;
alter table chamados add column if not exists aberto_por text;        -- nome de quem abriu pelo painel/app

-- Acesso do zelador por link (sem senha)
alter table usuarios add column if not exists token_acesso text unique;

-- Avisos: no grupo (padrão) ou no privado
alter table avisos add column if not exists canal text not null default 'grupo';

-- Controle para não chamar o mesmo morador no privado várias vezes por causa do grupo
alter table moradores add column if not exists abordado_grupo_em timestamptz;

-- Pasta privada de fotos no Storage do Supabase
insert into storage.buckets (id, name, public)
values ('fotos', 'fotos', false)
on conflict (id) do nothing;
