# Assistente do Condomínio (piloto)

Assistente de WhatsApp com IA que atende cada morador no privado, mais um painel web para a administração, o zelador, a portaria e o conselho.

Cada prédio tem a sua própria instalação: um app Node.js na Hostinger, um projeto Supabase e uma instância da Uazapi com o número do prédio.

## O que o piloto faz

**No WhatsApp (morador)**
- Reconhece o morador pelo número cadastrado pela administração. Número desconhecido recebe um aviso e entra na lista "sem cadastro" do painel.
- Abre chamados, informa o status e avisa quando é resolvido.
- Registra reclamações sem revelar quem reclamou, avisa a portaria e alerta o síndico na 3ª reclamação contra a mesma unidade em 30 dias.
- Responde dúvidas com base nos documentos do prédio (regimento, convenção) e encaminha o que não souber.
- Consulta a agenda do condomínio e agenda lembretes pessoais.
- Guarda uma memória de cada morador (fatos e resumo de perfil) e a usa nas conversas seguintes.
- Lê o grupo dos moradores, mas nunca escreve nele.

**No painel**
- Conexão do WhatsApp por QR code (ou código de pareamento), status ao vivo, escolha do grupo que será lido.
- Moradores: cadastro, importação de lista, números pendentes e ficha com a memória e a conversa.
- Chamados (administração e zelador), com tela pensada para celular.
- Reclamações (administração e portaria), sem o autor, com contagem de reincidência.
- Avisos individuais em massa, com fila lenta e horário permitido, e rascunho escrito pela IA.
- Agenda com lembrete automático na véspera.
- Manutenção preventiva: abre chamado e avisa o síndico antes do prazo.
- IA para decidir: resumo do dia, perguntas sobre os dados, radar do grupo, rascunho de notificação.
- Relatório mensal para o conselho e controle de acessos da equipe.

## Instalação de um prédio

### 1. Supabase
1. Crie um projeto em supabase.com (um por prédio).
2. Abra **SQL Editor > New query**, cole todo o arquivo `supabase/schema.sql` e clique em **Run**.
3. Em **Project Settings > API**, copie a **Project URL** e a chave **service_role**. Essa chave só fica no servidor, nunca no navegador.

### 2. Uazapi
1. No painel da Uazapi, crie uma instância para o prédio.
2. Copie o endereço do seu servidor (ex.: `https://seu-subdominio.uazapi.com`) e o **token da instância**.
3. Use um chip exclusivo do prédio. Antes de mandar avisos em massa, deixe o número em uso normal por uma ou duas semanas.

### 3. OpenAI
Crie uma chave em platform.openai.com. O modelo é definido em `OPENAI_MODEL` (padrão `gpt-4.1-mini`). Confira se ele ainda está disponível na sua conta e troque se precisar.

### 4. Hostinger (Node.js)
1. No hPanel, crie um app Node.js. Envie o projeto pelo GitHub ou por arquivo .zip (sem a pasta `node_modules` e sem o `.env`).
2. Versão do Node: 20 ou mais nova. Comando de instalação: `npm install`. Comando de início: `npm start` (arquivo de entrada `src/server.js`).
3. Cadastre as variáveis de ambiente listadas em `.env.example`:
   - `APP_URL`: o endereço público do app, com https e sem barra no final
   - `SESSION_SECRET` e `WEBHOOK_SECRET`: duas frases longas e aleatórias, diferentes entre si
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   - `UAZAPI_URL`, `UAZAPI_TOKEN`
   - `OPENAI_API_KEY`, `OPENAI_MODEL`
   - `TZ=America/Sao_Paulo`
4. Publique e abra o endereço. Confira em `/saude` se `faltando` está vazio.

### 5. Primeiro acesso
1. Abra o app: a tela **Primeiro acesso** cria o administrador e o nome do prédio.
2. **WhatsApp**: clique em **Gerar QR code** e leia com o celular do prédio. O webhook é configurado sozinho.
3. **WhatsApp > Escolher grupo**: selecione o grupo dos moradores (o número do prédio precisa estar no grupo).
4. **Configurações**: telefones do síndico, zelador e portaria para receber alertas.
5. **Documentos**: cole o regimento interno e a convenção.
6. **Moradores**: cadastre ou importe a lista (`nome; telefone; bloco; apartamento; e-mail; vaga`).

> Banco criado antes da versão com vaga de garagem? Rode `supabase/migracoes/002_vaga_morador.sql` no SQL Editor.
7. **Equipe**: crie os acessos do zelador, portaria e conselho.
8. **Manutenção** e **Agenda**: cadastre os itens e eventos.

## Rodar no computador

```bash
npm install
cp .env.example .env   # preencha os valores
npm run dev
```

O WhatsApp só entrega mensagens a um endereço público. Para testar o recebimento no computador, use um túnel (por exemplo, ngrok ou Cloudflare Tunnel) e coloque o endereço dele em `APP_URL`.

`npm run check` carrega todos os módulos, compila as telas e testa a leitura do webhook.

## Cuidados

- **Número bloqueado:** a Uazapi não é a API oficial do WhatsApp. Os avisos saem um por vez, com intervalo aleatório (`ENVIO_INTERVALO_MIN/MAX`) e só no horário permitido (`ENVIO_HORA_INICIO/FIM`). Não reduza esses valores. Tenha um número reserva.
- **LGPD:** os dados são do condomínio. A ficha do morador pode ser vista, corrigida e apagada no painel. Excluir um morador apaga a memória e as mensagens dele. Avise no grupo que o assistente lê as mensagens.
- **Anonimato:** o autor da reclamação fica no banco, mas não aparece em nenhuma tela.
- **Rotinas automáticas** (fila de avisos, lembretes, véspera de eventos, manutenção) rodam dentro do próprio servidor. Se o app da Hostinger for desligado por inatividade, elas param até o próximo acesso.

## Estrutura

```
supabase/schema.sql      banco de dados
src/server.js            servidor, webhook e painel
src/agente.js            o assistente (OpenAI com ferramentas e memória)
src/servicos.js          chamados, reclamações, avisos, envio
src/rotinas.js           tarefas automáticas
src/uazapi.js            cliente da Uazapi
src/rotas/               páginas do painel
views/                   telas (EJS)
public/                  estilo e scripts do painel
```

## Próximas fases (fora do piloto)

Boletos e lembrete de vencimento, reservas de áreas comuns, portaria (encomendas e visitantes), obras nas unidades, assembleias com enquete, fornecedores e boas-vindas a moradores novos.
