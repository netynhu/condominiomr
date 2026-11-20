-- Autocadastro pelo grupo: o morador que está no grupo do prédio se cadastra sozinho pelo WhatsApp.
-- A administração confere depois no painel. Rode no SQL Editor do Supabase (pode rodar mais de uma vez).
alter table moradores add column if not exists autocadastro boolean not null default false;
alter table moradores add column if not exists conferido boolean not null default true;
alter table contatos_pendentes add column if not exists dados jsonb not null default '{}'::jsonb;
notify pgrst, 'reload schema';
