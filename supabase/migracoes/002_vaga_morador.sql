-- Adiciona o número da vaga de garagem ao morador.
-- Rode no SQL Editor do Supabase se o banco foi criado antes desta versão.
alter table moradores add column if not exists vaga text;
