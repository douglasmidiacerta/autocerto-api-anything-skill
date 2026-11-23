# AutoCerto + API Anything Skill

Skill reutilizável para agentes de IA (**Antigravity**, **Claude Code**, **Codex**, **Cursor**, **Gemini CLI**, etc.) que automatiza a instalação, configuração e uso do **AutoCerto** (`sistema.autocerto.com`) via **[API Anything](https://github.com/goodnight000/api-anything)** — sem precisar de acesso à API oficial paga e sem precisar de navegador headless para as consultas.

## O que esta skill faz

- **Instala e valida** o `api-anything` (incluindo suporte a **Linux, macOS e Android/Termux/Antigravity CLI** com correção automática de `OPENSSL_CONF`).
- **Configura o spec local do AutoCerto** (`~/.api-anything/sites/autocerto.json`) com **8 operações somente leitura** em HTTP direto (`tier: 1`):
  - `listStock` — listar e filtrar estoque (busca rápida, placa, ano, preço, página)
  - `searchStockJson` — buscar estoque em JSON completo com valores numéricos exatos (`km`, `preco`, `reservado`, `anoFabricacao`, `anoModelo`)
  - `leadCounters` — contadores das pastas de leads (`Pendente`, `Andamento`, `AgendadosAtrasados`, `chegaramHoje`)
  - `listLeads` — listar leads por pasta (`pend`, `pri`, `and`, `atr`, `ag`, `agatr`, `aghoje`, `agfut`, `todos`)
  - `searchLeads` — consulta avançada por nome, telefone, veículo e datas
  - `getLeadConversation` — ler mensagens e anexos/áudios da conversa do lead
  - `getLeadHistory` — histórico de negociações do lead
  - `listAgenda` — agenda de visitas e ligações de follow-up
- **Orienta o login seguro via cookies** (Chrome/Edge/Brave no PC ou **Titanium Browser** no Android), sem nunca pedir senha ou cookies no chat.
- **Inclui playbook de follow-up** cruzando estoque + leads + conversas + agenda.

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
5. Mostra o comando para conectar o servidor MCP ao seu agente.

### 3. Importar a sessão do AutoCerto (sem senha no chat)

Exporte os cookies de `https://sistema.autocerto.com` já logado (veja [cookies-export.md](./skills/autocerto-api/references/cookies-export.md)) e rode:

```bash
api-anything login autocerto --cookies /caminho/para/autocerto-cookies.json
```

### 4. Testar

```bash
api-anything call autocerto leadCounters
api-anything call autocerto searchStockJson query=
api-anything call autocerto listLeads pasta=pend
```

---

## Segurança e Privacidade

- Este repositório **não contém** senhas, cookies, tokens, dados de loja ou clientes.
- Cookies importados ficam armazenados apenas localmente em `~/.api-anything/sessions/`.
- **Nunca** envie cookies ou senhas em conversas com IAs nem faça commit de arquivos `*cookies*` no Git.

## Licença

MIT
