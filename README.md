# Agente de Suporte de TI — WhatsApp + TomTicket

Assistente virtual de **primeiro nível** que atende clientes pelo WhatsApp (API oficial da Meta), identifica o cliente no TomTicket, abre e consulta chamados e transfere para um técnico quando necessário. O planejamento completo está em [PLANO.md](PLANO.md).

## O que a v1 faz

- Conversa natural em português, com mensagens curtas, no estilo do WhatsApp.
- **Atende só clientes já cadastrados no TomTicket**: identifica pelo e-mail e nunca cadastra cliente novo.
- **Abre chamado** com assunto, descrição estruturada e prioridade (baixa, normal, alta ou urgente), sempre depois de mostrar um resumo e o cliente confirmar.
- **Consulta chamados** (lista e detalhe por protocolo) e **complementa** um chamado aberto com o que o cliente enviar.
  - Por segurança, a consulta só é liberada quando o WhatsApp do cliente consta no cadastro do TomTicket (`REQUIRE_PHONE_MATCH_FOR_LOOKUP`).
- **Transfere para humano**: avisa a equipe por webhook (Teams, Slack, n8n…) e o robô fica em silêncio na conversa por `HANDOFF_PAUSE_HOURS`.
- **Detalhes de comportamento:**
  - Junta mensagens enviadas em sequência antes de responder.
  - Ignora mensagens que a Meta reenviar.
  - Processa uma conversa de cada vez.
  - Sabe se está dentro ou fora do horário de atendimento.
- **Vários números (multi-número)** já suportado na arquitetura. A v1 usa um único número.
- **Mídia:** áudio e imagem ainda não são lidos. O agente pede para o cliente escrever (previsto para a fase 3).

## Arquitetura

```
WhatsApp (Meta Cloud API) ──webhook──► src/server.ts
                                         └─ conversation/processor.ts  (dedupe, debounce, fila por conversa)
                                              └─ agent/agent.ts         (Claude + ferramentas)
                                                   ├─ agent/tools.ts    (regras de segurança)
                                                   │    └─ integrations/tomticket.ts  (API TomTicket v2.0)
                                                   └─ handoff/notify.ts (aviso à equipe)
                          store/db.ts (SQLite: contatos, sessões, auditoria de chamados)
```

## Rodando localmente

Requer Node.js 22.13 ou superior.

```bash
npm install
cp .env.example .env      # preencha os valores
npm run tomticket:check   # valida o token e lista os IDs de departamento/categoria
npm run tomticket:check -- cliente@empresa.com.br   # testa a busca de um cliente (só leitura)
npm test                  # testes automatizados (sem acessar nenhum serviço externo)
npm run dev               # servidor em http://localhost:3000
```

Em produção:

```bash
docker build -t atendimento-ia .
docker run -d --env-file .env -p 3000:3000 -v atendimento-data:/data atendimento-ia
```

O webhook precisa de **HTTPS público**: use um proxy reverso (Caddy ou Nginx), um túnel (Cloudflare Tunnel) ou uma plataforma que já entregue HTTPS.

## Configurando o WhatsApp (Meta) com o número atual do suporte

1. **App na Meta:** em developers.facebook.com, crie um app do tipo *Business* e adicione o produto **WhatsApp**. Vincule ao Business Manager da empresa.
2. **Conectar o número atual:** o número de suporte já está em uso no app WhatsApp Business, então use o fluxo de **coexistência**. Nesse modo, o número continua funcionando no app do celular e passa a funcionar também na Cloud API, e o histórico de conversas é preservado.
   - Confirme na Meta se o número é elegível: país, versão do app e tempo de uso.
   - Se o número estiver no WhatsApp comum (não Business), ou não for elegível, será preciso migrar o número para a Cloud API. Nesse caso ele deixa de funcionar no app do celular.
   - Faça um backup das conversas antes.
3. **Token permanente:** em Business Manager → Usuários do sistema, crie um usuário do sistema com permissão `whatsapp_business_messaging` e gere um token. Ele vai em `WHATSAPP_ACCESS_TOKEN`.
4. **IDs e segredo:**
   - Copie o **Phone number ID** em WhatsApp → Configuração da API e coloque em `WHATSAPP_PHONE_NUMBER_ID`.
   - Copie o **App Secret** em Configurações do app → Básico e coloque em `WHATSAPP_APP_SECRET`.
5. **Webhook:**
   - Em WhatsApp → Configuração, informe a URL de callback `https://SEU-DOMINIO/webhook/whatsapp`.
   - Use como token de verificação o mesmo valor de `WHATSAPP_VERIFY_TOKEN`.
   - Assine o campo **messages**.

> **Coexistência e técnicos:** com a coexistência, os técnicos continuam respondendo pelo app WhatsApp Business no celular depois de um handoff. O robô fica em silêncio por `HANDOFF_PAUSE_HOURS`. Para devolver a conversa ao robô antes desse prazo:
>
> ```bash
> curl -X POST https://SEU-DOMINIO/admin/resume \
>   -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
>   -d '{"channel_id":"<phone_number_id>","wa_id":"5511988887777"}'
> ```

## Configurando o TomTicket

1. Crie o token em **Administração → Configurações da Conta → API → Novo Token** e coloque em `TOMTICKET_TOKEN`.
2. Rode `npm run tomticket:check` e copie o ID do departamento de suporte para `TOMTICKET_DEPARTMENT_ID`. A categoria é opcional.
3. Para liberar a consulta de chamados pelo WhatsApp, mantenha o **telefone/celular** dos clientes atualizado no cadastro do TomTicket. A comparação aceita os formatos com ou sem +55 e com ou sem o 9.

Endpoints usados: `customer/details`, `ticket/new`, `ticket/list`, `ticket/detail`, `ticket/reply/customer`.

## Modelo do Claude e custo

- **Modelo:** definido em `LLM_MODEL` (padrão `claude-opus-5-5`, com `LLM_EFFORT=low`).
- **Comparação:** para comparar qualidade e custo, rode as mesmas conversas de teste com `claude-sonnet-5-5` e `claude-haiku-5-5`. A estimativa de custo está no [PLANO.md](PLANO.md).
- **Cache de prompt:** já está ativo.
- **Fallback:** nos modelos Opus e Sonnet, o fallback automático do servidor fica ligado. Se o modelo recusar uma mensagem por engano, a API tenta de novo com outro modelo em vez de deixar o cliente sem resposta.
- **Cobrança:** a API é cobrada à parte do plano Pro. Configure um limite de gasto no Console da Anthropic.

## Segurança e LGPD

- Toda requisição do webhook tem a assinatura `X-Hub-Signature-256` validada.
- Os tokens ficam só em variáveis de ambiente.
- As regras críticas são aplicadas no código, não só no prompt:
  - não abrir chamado sem cliente identificado nem sem confirmação;
  - só mostrar chamados do próprio cliente;
  - limitar as tentativas de identificação.
- O agente nunca pede senha.
- Histórico e auditoria ficam no SQLite (`DATABASE_PATH`). Defina uma política de retenção e inclua um aviso de privacidade na mensagem de boas-vindas.
