# Playbook de Follow-up com AutoCerto

Use este fluxo quando o usuário pedir para priorizar atendimento, revisar leads ou montar mensagens de follow-up cruzando o CRM com o estoque atual.

## Ordem recomendada de chamadas

1. **Panorama geral:**
   - `leadCounters` → identifica quantos leads estão em `Pendente`, `AgendadosAtrasados`, `AgendadosHoje` e `AndamentoAtrasado`.
2. **Fila prioritária (use `call_batch` quando disponível):**
   - `listLeads` com `pasta="pend"` (leads pendentes)
   - `listLeads` com `pasta="agatr"` (agendamentos atrasados)
   - `listAgenda` com `pagina=1` (próximos compromissos)
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
- **Lead:** Nome, telefone, mídia, pasta/atraso, temperatura (`1=Frio`, `2=Morno`, `3=Quente`).
- **Contexto:** Resumo em 1–2 linhas da última conversa e do interesse real.
- **Match de estoque:** Veículo de interesse (disponível/preço/km) ou alternativa sugerida.
- **Sugestão de mensagem (WhatsApp):** Curta, natural, personalizada ao contexto (sem texto robótico repetido) e com uma pergunta simples de resposta rápida.
