-- Perfil "sindico" na equipe: acesso completo ao painel e ao assistente pelo WhatsApp
alter table usuarios drop constraint if exists usuarios_perfil_check;
alter table usuarios add constraint usuarios_perfil_check check (perfil in ('sindico','admin','zelador','portaria','conselho'));
notify pgrst, 'reload schema';
