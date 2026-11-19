-- Vídeos nos chamados e respostas "em cima" de uma mensagem (citação).
-- Rode no SQL Editor do Supabase depois da 003 (pode rodar mais de uma vez).

-- Vídeo enviado pelo morador e anexado ao chamado (id na tabela fotos, que guarda qualquer mídia)
alter table chamados add column if not exists video text;

-- Id da mensagem no WhatsApp: permite saber a qual mensagem o morador respondeu
alter table mensagens add column if not exists wa_id text;
create index if not exists mensagens_wa_id_idx on mensagens (wa_id);
