# Como exportar cookies do AutoCerto com segurança

O AutoCerto (`https://sistema.autocerto.com`) utiliza autenticação por cookie (`.AspNet.ApplicationCookie`) e CAPTCHA na tela de login. Para conectar o `api-anything` sem digitar senha na IA e sem precisar de navegador headless, exporte os cookies de uma sessão já logada.

> **Segurança:** nunca cole sua senha ou o conteúdo do arquivo de cookies em chats de IA, e nunca envie o arquivo para repositórios Git.

---

## Android — Titanium Browser (ou Kiwi / navegadores Chromium com extensões)

1. Abra o **Titanium Browser** e acesse a **Chrome Web Store** (ative *"Para computador"* se necessário).
2. Instale a extensão **`Get cookies.txt LOCALLY`** (ou **`Cookie-Editor`**).
3. Acesse **`https://sistema.autocerto.com`** e faça login normalmente.
4. Com o painel aberto (ex.: `/Home` ou `/Lead/Lista`), abra a extensão no menu do navegador.
5. Exporte os cookies:
   - Com **Get cookies.txt LOCALLY**: toque em **Export** para baixar o arquivo direto em `/sdcard/Download/`.
   - Com **Cookie-Editor**: toque em **Export** → **Export as JSON** e salve em `/sdcard/Download/autocerto-cookies.json`.
6. No terminal, importe para o `api-anything`:
   ```bash
   api-anything login autocerto --cookies /sdcard/Download/autocerto-cookies.json
   ```
7. Após confirmar `"loggedIn": true`, apague o arquivo temporário de Downloads:
   ```bash
   rm -f /sdcard/Download/autocerto-cookies.json
   ```

---

## Desktop — Chrome, Edge ou Brave

### Opção A: Importação automática do perfil do navegador
Se o `api-anything` estiver rodando no mesmo computador onde você usa o Chrome/Edge/Brave:
```bash
api-anything login autocerto
```
O `api-anything` detecta seu perfil logado e pede confirmação no terminal antes de importar os cookies de `sistema.autocerto.com`.

### Opção B: Exportação manual via arquivo
1. Instale **Get cookies.txt LOCALLY** ou **Cookie-Editor** no navegador.
2. Com `https://sistema.autocerto.com` logado, exporte para `~/autocerto-cookies.json`.
3. Importe:
   ```bash
   api-anything login autocerto --cookies ~/autocerto-cookies.json
   rm -f ~/autocerto-cookies.json
   ```

---

## Renovando a sessão quando expirar

O cookie `.AspNet.ApplicationCookie` costuma expirar após algumas horas (~12h). Quando uma chamada retornar `class: "auth"`, basta repetir a exportação e rodar `api-anything login autocerto --cookies <arquivo>` novamente.
