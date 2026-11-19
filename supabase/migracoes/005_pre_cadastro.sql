-- Pré-cadastro: quem não é morador cadastrado pode pedir o cadastro pelo WhatsApp.
-- A administração aprova no painel ou pelo botão no WhatsApp.
-- Rode no SQL Editor do Supabase (pode rodar mais de uma vez).

alter table contatos_pendentes add column if not exists dados jsonb not null default '{}'::jsonb;

-- Atualiza o cache da API do Supabase para ela enxergar a coluna nova
notify pgrst, 'reload schema';
