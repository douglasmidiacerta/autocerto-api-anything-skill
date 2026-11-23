# AutoCerto + API Anything Skill

Skill reutilizável para agentes de IA (**Antigravity**, **Claude Code**, **Codex**, **Cursor**, **Gemini CLI**, etc.) que automatiza a instalação, configuração e operação do **AutoCerto** (`sistema.autocerto.com`) via **[API Anything](https://github.com/goodnight000/api-anything)** — sem precisar de acesso à API oficial paga e sem precisar de navegador headless.

## O que esta skill faz

- **Instala e valida** o `api-anything` (incluindo suporte a **Linux, macOS e Android/Termux/Antigravity CLI** com correção automática de `OPENSSL_CONF`).
- **Configura o spec local do AutoCerto** (`~/.api-anything/sites/autocerto.json`) em HTTP direto (`tier: 1`) com **10 operações somente leitura** e **9 operações de escrita protegidas por confirmação**:

### Operações somente leitura (`readOnly: true`)
- `listStock` — listar e filtrar estoque (busca rápida, placa, ano, preço, página)
- `searchStockJson` — buscar estoque em JSON completo com valores numéricos exatos (`km`, `preco`, `reservado`, `anoFabricacao`, `anoModelo`)
- `leadCounters` — contadores das pastas de leads (`Pendente`, `Andamento`, `AgendadosAtrasados`, `chegaramHoje`)
- `listLeads` — listar leads por pasta (`pend`, `pri`, `and`, `atr`, `ag`, `agatr`, `aghoje`, `agfut`, `todos`)
- `searchLeads` — consulta avançada por nome, telefone, veículo e datas
- `getLeadConversation` — ler mensagens e anexos/áudios da conversa do lead
- `getLeadHistory` — histórico de negociações do lead
- `listAgenda` — agenda de visitas e ligações de follow-up
- `listLeadStatuses` — situações (substatus) de acompanhamento configuradas na loja
- `listWhatsappTemplates` — modelos aprovados do WhatsApp disponíveis para um lead

### Operações de escrita (`readOnly: false` — bloqueadas sem `--allow-writes`)
- `scheduleLead` (`POST /Lead/Agendar`) — agendar visita (`tipo=1`) ou ligação (`tipo=2`) de follow-up
- `replyLead` (`POST /Lead/Responder`) — enviar mensagem de resposta ao cliente (WhatsApp, Messenger, Direct, E-mail, Chat OLX)
- `sendWhatsappTemplate` (`POST /Lead/Responder`) — enviar modelo aprovado do WhatsApp (ideal para reativar leads fora da janela de 24h)
- `commentLead` (`POST /Lead/Comentar`) — registrar comentário/nota interna no lead (não envia ao cliente)
- `updateLeadTemperature` (`POST /Lead/AlterarTemperatura`) — alterar temperatura (`1=Frio`, `2=Morno`, `3=Quente`)
- `updateLeadStatus` (`POST /Lead/AlterarSituacao`) — alterar situação/substatus de acompanhamento
- `completeAppointment` (`POST /Lead/ConcluirAgendamentoLead`) — concluir visita/ligação agendada (com opção de reagendar)
- `confirmAppointment` (`POST /Agenda/Confirmar`) — confirmar presença em um agendamento
- `rescheduleAppointmentTime` (`POST /Agenda/AlterarHorario`) — alterar horário do agendamento no mesmo dia

- **Sincroniza o token anti-CSRF com segurança** via [sync-csrf.mjs](./skills/autocerto-api/scripts/sync-csrf.mjs) diretamente na sessão selada do `api-anything` (`~/.api-anything/sessions/autocerto.json`), sem nunca exibir o token no terminal.
- **Orienta o login seguro via cookies** (Chrome/Edge/Brave no PC ou **Titanium Browser** no Android), sem nunca pedir senha ou cookies no chat.
- **Inclui playbook de follow-up** cruzando estoque + leads + conversas + agenda, com trava obrigatória de confirmação humana antes de qualquer escrita.

---

## Instalação rápida

### 1. Instalar a skill no seu agente de IA

Clone este repositório e copie a pasta `skills/autocerto-api` para o diretório de skills do seu agente:

| Agente | Caminho das skills |
| --- | --- |
| **Antigravity** | `~/.gemini/config/skills/autocerto-api/` |
| **Claude Code** | `~/.claude/skills/autocerto-api/` |
| **Codex / Cursor / Gemini CLI** | `~/.agents/skills/autocerto-api/` |

Exemplo:

```bash
git clone https://github.com/douglasmidiacerta/autocerto-api-anything-skill.git
mkdir -p ~/.agents/skills ~/.gemini/config/skills
cp -r autocerto-api-anything-skill/skills/autocerto-api ~/.agents/skills/
cp -r autocerto-api-anything-skill/skills/autocerto-api ~/.gemini/config/skills/
```

### 2. Rodar o instalador automático

```bash
bash autocerto-api-anything-skill/skills/autocerto-api/scripts/install.sh
```

O script:
1. Verifica se o Node.js `>= 22.13.0` está instalado.
2. Instala o pacote global `api-anything` (se ainda não estiver instalado).
3. Em ambientes Android/Termux, ajusta `OPENSSL_CONF` automaticamente.
4. Instala o spec [autocerto.json](./skills/autocerto-api/resources/autocerto.json) em `~/.api-anything/sites/autocerto.json`.
5. Se já existir sessão ativa, sincroniza automaticamente o token `__RequestVerificationToken` com [sync-csrf.mjs](./skills/autocerto-api/scripts/sync-csrf.mjs).

### 3. Importar a sessão do AutoCerto e sincronizar o token anti-CSRF

Exporte os cookies de `https://sistema.autocerto.com` já logado (veja [cookies-export.md](./skills/autocerto-api/references/cookies-export.md)) e rode:

```bash
api-anything login autocerto --cookies /caminho/para/autocerto-cookies.json
node autocerto-api-anything-skill/skills/autocerto-api/scripts/sync-csrf.mjs
```

### 4. Testar leitura e simulação (`--dry`) de escrita

```bash
# Leitura
api-anything call autocerto leadCounters
api-anything call autocerto listLeadStatuses
api-anything call autocerto listLeads pasta=pend

# Simulação segura de escrita (--dry NÃO envia nada ao servidor)
api-anything call autocerto scheduleLead id=123 tipo=2 dia=25/11/2026 hora=14:30 observacao="Retorno de proposta" --dry
api-anything call autocerto replyLead id=123 canal=1 texto="Olá! Tudo bem?" --dry
```

Para executar uma escrita de verdade via CLI (somente após conferir os dados), passe `--allow-writes`. No servidor MCP, inicie com `api-anything mcp --allow-writes` para expor a ferramenta `call_write_operation`.

---

## Segurança e Privacidade

- Este repositório **não contém** senhas, cookies, tokens, dados de loja ou clientes.
- Cookies importados e o token anti-CSRF ficam armazenados apenas localmente em `~/.api-anything/sessions/` (permissão `0600`).
- Todas as operações de escrita exigem `--allow-writes` explícito e validação prévia dos parâmetros (formato de data/hora, canal, temperatura e IDs).
- **Nunca** envie cookies ou senhas em conversas com IAs nem faça commit de arquivos `*cookies*` no Git.

## Licença

MIT
