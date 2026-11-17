require('dotenv').config();

if (!process.env.TZ) process.env.TZ = 'America/Sao_Paulo';

const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));

const env = {
  APP_URL: (process.env.APP_URL || '').replace(/\/+$/, ''),
  PORT: num(process.env.PORT, 3000),
  SESSION_SECRET: process.env.SESSION_SECRET || '',
  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  UAZAPI_URL: (process.env.UAZAPI_URL || '').replace(/\/+$/, ''),
  UAZAPI_TOKEN: process.env.UAZAPI_TOKEN || '',
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || '',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  ENVIO_INTERVALO_MIN: num(process.env.ENVIO_INTERVALO_MIN, 25),
  ENVIO_INTERVALO_MAX: num(process.env.ENVIO_INTERVALO_MAX, 60),
  ENVIO_HORA_INICIO: num(process.env.ENVIO_HORA_INICIO, 8),
  ENVIO_HORA_FIM: num(process.env.ENVIO_HORA_FIM, 21),
};

const faltando = ['SESSION_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'UAZAPI_URL', 'UAZAPI_TOKEN', 'WEBHOOK_SECRET', 'OPENAI_API_KEY', 'APP_URL']
  .filter((k) => !env[k]);

module.exports = { env, faltando };
