-- Encomendas: a portaria registra, o WhatsApp avisa os moradores do apartamento e cobra a retirada
-- até alguém tocar em "Já retirei" (ou a portaria marcar como entregue).
-- Rode no SQL Editor do Supabase (pode rodar mais de uma vez).
create table if not exists encomendas (
  id bigserial primary key,
  condominio_id uuid not null references condominios(id) on delete cascade,
  unidade_id uuid references unidades(id) on delete set null,
  remetente text,                         -- Mercado Livre, Correios, Shopee...
  tipo text not null default 'pacote' check (tipo in ('pacote','envelope','comida','volumoso','outro')),
  observacao text,
  foto text,                              -- id na tabela fotos
  status text not null default 'aguardando' check (status in ('aguardando','retirada','devolvida')),
  recebida_por text,                      -- quem da portaria registrou
  recebida_em timestamptz not null default now(),
  avisos int not null default 0,          -- quantas vezes o morador foi avisado
  ultimo_aviso_em timestamptz,
  retirada_em timestamptz,
  retirada_por text,                      -- nome de quem confirmou
  sindico_avisado_em timestamptz          -- passou do prazo e a administração foi avisada
);
create index if not exists encomendas_condominio_status_idx on encomendas (condominio_id, status, recebida_em);
alter table encomendas enable row level security;
notify pgrst, 'reload schema';
