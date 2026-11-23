-- Vários condomínios no mesmo sistema (e no mesmo número de WhatsApp).
-- Tudo o que é do prédio passa a ter condominio_id. Os dados que já existem viram o primeiro condomínio.
-- Rode no SQL Editor do Supabase UMA vez, inteiro. Ele pode ser rodado de novo sem estragar nada.

-- 1. Condomínios
create table if not exists condominios (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  ativo boolean not null default true,
  criado_em timestamptz not null default now()
);
alter table condominios enable row level security;

-- O primeiro condomínio recebe todos os dados atuais (nome vem dos ajustes)
insert into condominios (nome)
select coalesce((select valor from config where chave = 'nome_predio' and valor <> ''), 'Condomínio')
where not exists (select 1 from condominios);

-- 2. condominio_id em todas as tabelas do prédio, preenchido com o primeiro condomínio
do $$
declare
  t text;
  primeiro uuid := (select id from condominios order by criado_em limit 1);
begin
  foreach t in array array['unidades','moradores','mensagens','chamados','reclamacoes','eventos','lembretes','avisos',
                           'fila_envio','documentos','manutencoes','grupo_mensagens','config','duvidas','contatos_pendentes'] loop
    execute format('alter table %I add column if not exists condominio_id uuid references condominios(id) on delete cascade', t);
    execute format('update %I set condominio_id = %L where condominio_id is null', t, primeiro);
    execute format('create index if not exists %I on %I (condominio_id)', t || '_condominio_idx', t);
  end loop;
end $$;

-- Mensagens de quem ainda não é morador (pedido de cadastro) podem ficar sem condomínio
alter table mensagens alter column condominio_id drop not null;
alter table contatos_pendentes alter column condominio_id drop not null;
do $$
declare t text;
begin
  foreach t in array array['unidades','moradores','chamados','reclamacoes','eventos','lembretes','avisos',
                           'fila_envio','documentos','manutencoes','grupo_mensagens','config','duvidas'] loop
    execute format('alter table %I alter column condominio_id set not null', t);
  end loop;
end $$;

-- 3. Chaves únicas passam a valer dentro de cada condomínio
-- Morador: o mesmo telefone pode morar em dois condomínios
alter table moradores drop constraint if exists moradores_telefone_key;
create unique index if not exists moradores_condominio_telefone_key on moradores (condominio_id, telefone);
-- Unidade: o apto 101 existe em vários prédios
alter table unidades drop constraint if exists unidades_bloco_numero_key;
create unique index if not exists unidades_condominio_bloco_numero_key on unidades (condominio_id, bloco, numero);
-- Ajustes: cada condomínio tem os seus
alter table config drop constraint if exists config_pkey;
create unique index if not exists config_condominio_chave_key on config (condominio_id, chave);

-- 4. Equipe: cada pessoa pode atender um ou mais condomínios
create table if not exists usuario_condominios (
  usuario_id uuid not null references usuarios(id) on delete cascade,
  condominio_id uuid not null references condominios(id) on delete cascade,
  primary key (usuario_id, condominio_id)
);
alter table usuario_condominios enable row level security;
-- "dono": quem administra a plataforma (cria condomínios e vê todos)
alter table usuarios add column if not exists dono boolean not null default false;
-- Condomínio que a pessoa está usando no painel ou no WhatsApp do síndico
alter table usuarios add column if not exists condominio_atual uuid references condominios(id) on delete set null;

-- A equipe atual passa a atender o primeiro condomínio; os administradores atuais viram "dono"
insert into usuario_condominios (usuario_id, condominio_id)
select u.id, (select id from condominios order by criado_em limit 1) from usuarios u
on conflict do nothing;
update usuarios set dono = true where perfil = 'admin' and not exists (select 1 from usuarios where dono);

-- 5. Aviso com imagem (a imagem fica na tabela fotos)
alter table avisos add column if not exists imagem text;

-- 6. Morador que mora em dois condomínios: lembra qual ele escolheu por último
alter table moradores add column if not exists conversa_em timestamptz;

notify pgrst, 'reload schema';
