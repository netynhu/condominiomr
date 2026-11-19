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

// Descreve uma foto para o assistente "enxergar" o que o morador mandou
async function descreverImagem(buffer, mime = 'image/jpeg', contexto = '') {
  // Imagens minúsculas (miniaturas, ícones) fazem a IA inventar conteúdo: nem tenta
  if (!buffer || buffer.length < 4000) return 'Foto ilegível';
  const r = await openai().chat.completions.create({
    model: env.OPENAI_MODEL,
    temperature: 0.2,
    max_tokens: 160,
    messages: [
      { role: 'system', content: 'Você descreve fotos enviadas por moradores de condomínio ao assistente do prédio. Em português, em até 2 frases objetivas: o que aparece e, se houver, qual problema (algo quebrado, vazamento, sujeira, carro mal parado, risco). Leia placas, números de vaga ou de apartamento se estiverem visíveis. Não identifique pessoas pelo rosto. Descreva só o que dá para ver com clareza: se a imagem estiver em branco, escura, muito pequena, borrada ou ilegível, responda apenas "Foto ilegível" e nunca invente o conteúdo.' },
      { role: 'user', content: [
        { type: 'text', text: contexto ? `Legenda ou contexto do morador: ${contexto}` : 'Descreva a foto.' },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${buffer.toString('base64')}`, detail: 'auto' } },
      ] },
    ],
  });
  return (r.choices[0]?.message?.content || '').trim();
}

module.exports = { openai, completar, descreverImagem };
