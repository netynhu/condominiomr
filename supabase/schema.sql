-- Assistente do Condomínio - banco do piloto
-- Rode este arquivo inteiro no Supabase: SQL Editor > New query > colar > Run.
-- Cada prédio tem o seu próprio projeto Supabase, então não há coluna de condomínio.

create extension if not exists pgcrypto;

-- Usuários do painel
create table if not exists usuarios (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  email text not null unique,
  senha_hash text not null,
  perfil text not null check (perfil in ('admin','zelador','portaria','conselho')),
  telefone text,
  ativo boolean not null default true,
  criado_em timestamptz not null default now()
);

-- Unidades e moradores (cadastro feito só pela administração)
create table if not exists unidades (
  id uuid primary key default gen_random_uuid(),
  bloco text not null default '',
  numero text not null,
  observacao text,
  criado_em timestamptz not null default now(),
  unique (bloco, numero)
);

create table if not exists moradores (
  id uuid primary key default gen_random_uuid(),
  unidade_id uuid references unidades(id) on delete set null,
  nome text not null,
  telefone text not null unique,          -- só dígitos, com DDI: 5511999998888
  email text,
  vaga text,                              -- número da vaga de garagem (ex.: "12" ou "12, 13")
  tipo text not null default 'morador' check (tipo in ('proprietario','inquilino','morador','outro')),
  ativo boolean not null default true,
  aceita_avisos boolean not null default true,
  resumo_perfil text,                     -- resumo que a IA mantém sobre a pessoa
  ultima_interacao timestamptz,
  criado_em timestamptz not null default now()
);

-- Memória do morador: fatos que o assistente aprende nas conversas
create table if not exists memoria (
  id uuid primary key default gen_random_uuid(),
  morador_id uuid not null references moradores(id) on delete cascade,
  fato text not null,
  origem text not null default 'conversa',  -- conversa | grupo | administracao
  criado_em timestamptz not null default now()
);

-- Histórico das conversas privadas
create table if not exists mensagens (
  id bigserial primary key,
  morador_id uuid references moradores(id) on delete set null,
  telefone text not null,
  direcao text not null check (direcao in ('entrada','saida')),
  texto text not null,
  criado_em timestamptz not null default now()
);
create index if not exists mensagens_tel_idx on mensagens (telefone, criado_em desc);

-- Números que escreveram e não estão no cadastro
create table if not exists contatos_pendentes (
  telefone text primary key,
  nome_whatsapp text,
  ultima_mensagem text,
  vezes int not null default 1,
  atualizado_em timestamptz not null default now()
);

-- Chamados de manutenção
create table if not exists chamados (
  id bigserial primary key,               -- é o número do chamado
  morador_id uuid references moradores(id) on delete set null,
  titulo text not null,
  descricao text,
  local text,
  categoria text not null default 'manutencao',
  prioridade text not null default 'normal' check (prioridade in ('baixa','normal','alta','urgente')),
  status text not null default 'aberto' check (status in ('aberto','em_andamento','resolvido','cancelado')),
  origem text not null default 'whatsapp', -- whatsapp | painel | manutencao_preventiva
  observacao_equipe text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  resolvido_em timestamptz
);

create table if not exists chamado_historico (
  id bigserial primary key,
  chamado_id bigint not null references chamados(id) on delete cascade,
  usuario_nome text,
  acao text not null,
  criado_em timestamptz not null default now()
);

-- Reclamações (o autor fica guardado, mas o painel não mostra)
create table if not exists reclamacoes (
  id bigserial primary key,
  autor_morador_id uuid references moradores(id) on delete set null,
  unidade_alvo text,                      -- ex.: "209" ou "B-209"
  tipo text not null default 'outro',     -- barulho, vaga, animal, lixo, obra, convivencia, outro
  descricao text not null,
  acontecendo_agora boolean not null default false,
  status text not null default 'nova' check (status in ('nova','em_tratamento','resolvida','arquivada')),
  tratativa text,
  tratada_por text,
  criado_em timestamptz not null default now(),
  tratada_em timestamptz
);

-- Agenda do condomínio
create table if not exists eventos (
  id uuid primary key default gen_random_uuid(),
  titulo text not null,
  descricao text,
  local text,
  inicio timestamptz not null,
  fim timestamptz,
  publico text not null default 'todos',  -- todos | bloco:B
  avisar_vespera boolean not null default true,
  lembrete_enviado boolean not null default false,
  criado_em timestamptz not null default now()
);

-- Lembretes pessoais que o morador pede ao assistente
create table if not exists lembretes (
  id uuid primary key default gen_random_uuid(),
  morador_id uuid not null references moradores(id) on delete cascade,
  texto text not null,
  enviar_em timestamptz not null,
  enviado boolean not null default false,
  criado_em timestamptz not null default now()
);

-- Avisos em massa
create table if not exists avisos (
  id uuid primary key default gen_random_uuid(),
  titulo text not null,
  texto text not null,
  publico text not null default 'todos',
  status text not null default 'rascunho' check (status in ('rascunho','enviando','enviado')),
  total int not null default 0,
  criado_por text,
  criado_em timestamptz not null default now(),
  enviado_em timestamptz
);

-- Fila de envio (os avisos saem aos poucos para proteger o número)
create table if not exists fila_envio (
  id bigserial primary key,
  telefone text not null,
  texto text not null,
  aviso_id uuid references avisos(id) on delete cascade,
  status text not null default 'pendente' check (status in ('pendente','enviado','erro')),
  tentativas int not null default 0,
  erro text,
  agendado_para timestamptz not null default now(),
  enviado_em timestamptz
);
create index if not exists fila_pendente_idx on fila_envio (status, agendado_para);

-- Documentos que o assistente usa para responder (regimento, convenção, atas, contatos)
create table if not exists documentos (
  id uuid primary key default gen_random_uuid(),
  titulo text not null,
  conteudo text not null,
  ativo boolean not null default true,
  criado_em timestamptz not null default now()
);

-- Manutenção preventiva
create table if not exists manutencoes (
  id uuid primary key default gen_random_uuid(),
  titulo text not null,
  descricao text,
  proxima_data date not null,
  periodicidade_dias int not null default 365,
  antecedencia_dias int not null default 15,
  alerta_enviado_para date,               -- proxima_data já alertada
  criado_em timestamptz not null default now()
);

-- Mensagens do grupo dos moradores (somente leitura)
create table if not exists grupo_mensagens (
  id bigserial primary key,
  telefone text,
  nome text,
  morador_id uuid references moradores(id) on delete set null,
  texto text not null,
  criado_em timestamptz not null default now()
);
create index if not exists grupo_data_idx on grupo_mensagens (criado_em desc);

-- Configurações do prédio (nome, telefones da equipe, grupo, resumo do dia)
create table if not exists config (
  chave text primary key,
  valor text
);

-- Segurança: o sistema acessa o banco só pelo servidor, com a chave service_role.
-- Ligar o RLS sem políticas bloqueia qualquer acesso pela chave pública (anon).
alter table usuarios enable row level security;
alter table unidades enable row level security;
alter table moradores enable row level security;
alter table memoria enable row level security;
alter table mensagens enable row level security;
alter table contatos_pendentes enable row level security;
alter table chamados enable row level security;
alter table chamado_historico enable row level security;
alter table reclamacoes enable row level security;
alter table eventos enable row level security;
alter table lembretes enable row level security;
alter table avisos enable row level security;
alter table fila_envio enable row level security;
alter table documentos enable row level security;
alter table manutencoes enable row level security;
alter table grupo_mensagens enable row level security;
alter table config enable row level security;

-- ===== Versão 0.3: app do zelador, fotos, avaliação e avisos no grupo =====

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

-- ===== Versão 0.4: vídeos e citações =====

-- Vídeo enviado pelo morador e anexado ao chamado (id na tabela fotos, que guarda qualquer mídia)
alter table chamados add column if not exists video text;

-- Id da mensagem no WhatsApp: permite saber a qual mensagem o morador respondeu
alter table mensagens add column if not exists wa_id text;
create index if not exists mensagens_wa_id_idx on mensagens (wa_id);

-- ===== Versão 0.5: pré-cadastro =====
alter table contatos_pendentes add column if not exists dados jsonb not null default '{}'::jsonb;

-- Atualiza o cache da API do Supabase para enxergar tudo o que foi criado acima
notify pgrst, 'reload schema';
