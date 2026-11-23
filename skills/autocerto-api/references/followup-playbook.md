# Playbook de Follow-up com AutoCerto

Use este fluxo quando o usuário pedir para priorizar atendimento, revisar leads, montar mensagens de follow-up ou executar ações no CRM cruzando estoque + leads + conversas + agenda.

## Ordem recomendada de chamadas (somente leitura)

1. **Panorama geral:**
   - `leadCounters` → identifica quantos leads estão em `Pendente`, `AgendadosAtrasados`, `AgendadosHoje` e `AndamentoAtrasado`.
2. **Fila prioritária (use `call_batch` quando disponível):**
   - `listLeads` com `pasta="pend"` (leads pendentes)
   - `listLeads` com `pasta="agatr"` (agendamentos atrasados)
   - `listAgenda` com `pagina=1` (próximos compromissos)
   - `listLeadStatuses` (caso vá sugerir mudança de situação ou agendamento com situação)
3. **Estoque atual:**
   - `searchStockJson` com `query=""` (retorna todos os veículos em estoque com preço, ano, km, placa e se está reservado).
4. **Contexto real antes de sugerir mensagem:**
   - Para cada lead priorizado, chame `getLeadConversation(id)` e `getLeadHistory(id)` para entender:
     - Qual veículo ou faixa de preço o cliente busca;
     - Se tem carro na troca;
     - Se há restrição de horário (ex.: só sábado) ou condição de entrada/financiamento;
     - Qual foi a última mensagem enviada (evitar repetir mensagem idêntica de follow-up!).

## Cruzamento Lead × Estoque

- Se o veículo original do lead **ainda está no estoque** (`reservado: false`): confirme disponibilidade e proponha próximo passo concreto (visita, simulação atualizada ou avaliação do usado).
- Se o veículo original **não está mais no estoque** (ou está reservado): busque no resultado de `searchStockJson` 1 a 2 alternativas próximas em **modelo/categoria, ano e faixa de preço** para oferecer como opção na mensagem.

## Formato sugerido de resposta ao usuário

Para cada lead priorizado, entregue:
- **Lead:** Nome, `IdLead`, telefone, mídia, pasta/atraso, temperatura (`1=Frio`, `2=Morno`, `3=Quente`).
- **Contexto:** Resumo em 1–2 linhas da última conversa e do interesse real.
- **Match de estoque:** Veículo de interesse (disponível/preço/km) ou alternativa sugerida.
- **Sugestão de mensagem (WhatsApp):** Curta, natural, personalizada ao contexto (sem texto robótico repetido) e com uma pergunta simples de resposta rápida.
- **Ações sugeridas no AutoCerto (aguardando confirmação):** ex.: enviar via `replyLead`, registrar nota interna via `commentLead`, agendar próximo retorno via `scheduleLead`, ajustar temperatura via `updateLeadTemperature`.

## Execução de ações de escrita (somente após confirmação explícita)

Nunca envie mensagens nem altere leads automaticamente. Quando o usuário aprovar uma ou mais ações:

1. **Confirme o resumo exato antes do envio** (se ainda houver qualquer ajuste pendente):
   - Lead (`IdLead` e nome), canal/data/hora e texto exato.
2. **Execute a ação correspondente** (via MCP `call_write_operation` ou CLI com `--allow-writes`):
   - **Responder ao cliente:** `replyLead(id, texto, canal=1)` *(atenção: se o WhatsApp estiver fora da janela de 24h, o AutoCerto retornará `exigeModelo: true` — avise o usuário em vez de tentar de novo).*
   - **Agendar follow-up:** `scheduleLead(id, tipo=2, dia="dd/mm/aaaa", hora="HH:MM", observacao="...")` (`tipo=1` para visita, `tipo=2` para ligação).
   - **Registrar nota interna:** `commentLead(id, texto, situacao="")`.
   - **Atualizar temperatura / situação:** `updateLeadTemperature(id, temperatura)` / `updateLeadStatus(id, situacao)`.
   - **Gerir agenda existente:** `confirmAppointment`, `rescheduleAppointmentTime` ou `completeAppointment`.
3. **Verifique o retorno JSON** (`ok: true` e `mensagem`). Se retornar `"Sessão expirada"`, rode `node ./scripts/sync-csrf.mjs` (ou re-importe cookies) e só tente novamente com aval do usuário.
