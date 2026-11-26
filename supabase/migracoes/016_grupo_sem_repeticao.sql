-- A Uazapi entrega cada mensagem de grupo duas vezes. Guardar o id do WhatsApp e não aceitar repetido
-- garante que a mesma mensagem seja tratada uma vez só (mesmo com mais de um processo no servidor).
-- Pode rodar mais de uma vez.
alter table grupo_mensagens add column if not exists wa_id text;
create unique index if not exists grupo_mensagens_wa_id_uniq on grupo_mensagens (condominio_id, wa_id) where wa_id is not null;
notify pgrst, 'reload schema';
