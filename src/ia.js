const OpenAI = require('openai');
const { env } = require('./config');

let cliente;
function openai() {
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY não configurada.');
  if (!cliente) cliente = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return cliente;
}

// Chamada simples: instrução + conteúdo -> texto
async function completar(sistema, usuario, { temperatura = 0.3, maxTokens = 1200 } = {}) {
  const r = await openai().chat.completions.create({
    model: env.OPENAI_MODEL,
    temperature: temperatura,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: sistema },
      { role: 'user', content: usuario },
    ],
  });
  return (r.choices[0]?.message?.content || '').trim();
}

module.exports = { openai, completar };
