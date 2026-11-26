# Playbook de Follow-up com AutoCerto

Use este fluxo quando o usuário pedir para priorizar atendimento, organizar disparos em massa, revisar leads, montar mensagens de follow-up ou executar ações no CRM cruzando estoque + leads + conversas + agenda.

## Ordem recomendada de chamadas (somente leitura)

1. **Panorama geral:**
   - `leadCounters` → identifica quantos leads estão em `Pendente`, `PrimeiroAtendimento`, `AgendadosAtrasados`, `AgendadosHoje` e `AndamentoAtrasado`.
2. **Fila prioritária (use `call_batch` quando disponível):**
   - `listLeads` com `pasta="pend"` (leads pendentes) e `pasta="pri"` (1º atendimento)
   - `listLeads` com `pasta="agatr"` (agendamentos atrasados)
   - `listAgenda` com `pagina=1` (próximos compromissos)
   - `listLeadStatuses` (situações/substatus configuradas na loja)
   - `listWhatsappTemplates(id)` (modelos aprovados disponíveis para reabrir conversas fora da janela de 24h)
3. **Estoque atual:**
   - `searchStockJson` com `query=""` (retorna todos os veículos em estoque com preço, ano, km, placa e se está reservado).
4. **Contexto real antes de sugerir mensagem:**
   - Para cada lead priorizado, chame `getLeadConversation(id)` e `getLeadHistory(id)`. Se `getLeadConversation` retornar apenas os itens mais antigos (ex.: ~33–35 itens) e houver `CursorNovas`, chame `getLeadNewMessages(id, depois="<IdUltimoItem>-0")` em loop até buscar todas as mensagens recentes de hoje, para entender:
     - Qual veículo ou faixa de preço o cliente busca (e se ainda está no estoque);
     - Se tem carro na troca (modelo, ano, km, FIPE/valor pedido);
     - Se há **áudios** (`AnexoTipo: "audio"`) — baixe e ouça/transcreva o áudio antes de responder para não perder detalhes de troca, entrada ou restrições;
     - Qual valor de entrada / condição de financiamento;
     - Qual foi a última mensagem enviada (para **continuar o assunto sem repetir saudação robótica** — ex.: se o disparo já mandou *"Bom dia!"* e o cliente respondeu *"Bom dia / Sim"*, não comece a resposta com outro *"Bom dia!"*).

---

## Organização para Disparo em Lote (Follow-up em Massa)

Ao organizar leads ativos para disparo em grupo com template aprovado (`sendWhatsappTemplate`):
1. **Separe em grupos claros:**
   - **G1 — Prioridade (Pendentes ou cliente respondeu por último):** **fora** do disparo genérico; exige resposta personalizada.
   - **G2 — Mornos Agendados Aptos:** na fila do disparo.
   - **G3 — Mornos com Carro NO Estoque:** na fila do disparo (abordagem focada no carro disponível).
   - **G4 — Mornos (Carro Vendido ou Sem Carro):** na fila do disparo (abordagem oferecendo alternativas na mesma faixa/categoria).
   - **Frios (`termometro=1`):** **fora** do disparo.
2. **Deduplique por telefone:** nunca envie duas vezes para o mesmo número de telefone no mesmo lote.
3. **Respeite a janela de 24h do WhatsApp:**
   - Fora da janela de 24h, `replyLead` será recusado (`ok: false`). Use `sendWhatsappTemplate(id, modelo)`.
   - Dentro da janela de 24h, use `replyLead(id, texto, canal=1)` e verifique no retorno se `textoEnviado: true` e `status: 2`.

---

## Regras de Atendimento & Conversão

- **Sempre que houver carro na troca:**
  1. Peça os dados completos do usado com o bloco padrão:
     ```text
     Qual seria o veículo, amigo?
     KM
     Ano
     Modelo
     FIPE
     O que você está pedindo nele?
     ```
  2. E o foco principal é **trazer o cliente presencialmente à loja** para avaliar o usado na hora (e consolidar um resumo dos carros na troca para o gerente pré-avaliar).
- **Cliente que informou "Já comprei":**
  1. Agradeça parabenizando pela compra e deixando a porta aberta (*"em caso de troca no futuro, pode procurar a gente"*);
  2. Altere a temperatura para **Frio** (`updateLeadTemperature(id, temperatura=1)`);
  3. Agende retorno futuro para **1 ano** (`scheduleLead(id, tipo=2, dia="dd/mm/aaaa", hora="10:00", observacao="Já comprou...")`).
- **Cliente pedindo simulação de financiamento:**
  - Confirme **CPF**, **data de nascimento**, **valor de entrada** (ou se é sem entrada) e **veículo específico disponível no estoque**.
  - Se o carro original já foi vendido, **avise antes e peça para o cliente escolher uma alternativa disponível** na mesma faixa de preço para então rodar a simulação.
- **Zerar Pendentes (`status: 1`):**
  - Responda quem está dentro da janela de 24h via `replyLead`.
  - Para leads quentes fora da janela de 24h, reabra com `sendWhatsappTemplate`.

---

## Execução de ações de escrita (somente após confirmação explícita)

Nunca envie mensagens nem altere leads automaticamente. Quando o usuário aprovar uma ou mais ações:

1. **Confirme o resumo exato antes do envio** (destinatário `IdLead`/nome, canal/data/hora e texto exato).
2. **Execute a ação correspondente** (via MCP com `--allow-writes` ou CLI com `--allow-writes`):
   - **Responder ao cliente (24h aberta):** `replyLead(id, texto, canal=1)`
   - **Enviar modelo aprovado (fora de 24h):** `sendWhatsappTemplate(id, modelo)`
   - **Agendar follow-up:** `scheduleLead(id, tipo=2, dia="dd/mm/aaaa", hora="HH:MM", observacao="...")` (`tipo=1` visita, `tipo=2` ligação).
   - **Registrar nota interna:** `commentLead(id, texto, situacao="")`.
   - **Atualizar temperatura / situação:** `updateLeadTemperature(id, temperatura)` / `updateLeadStatus(id, situacao)`.
   - **Gerir agenda existente:** `confirmAppointment`, `rescheduleAppointmentTime` ou `completeAppointment`.
3. **Verifique o retorno JSON** (`ok: true`, `write: "accepted"`). Se retornar `"Sessão expirada"` ou `Success is false` por token anti-CSRF, rode `node ./scripts/sync-csrf.mjs` (ou reimporte os cookies com `api-anything login autocerto --cookies <arquivo>`).
