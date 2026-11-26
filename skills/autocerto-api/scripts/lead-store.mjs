import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const OPENSSL_CONF_DEFAULT =
  process.env.OPENSSL_CONF ||
  (process.env.PREFIX ? path.join(process.env.PREFIX, "etc", "tls", "openssl.cnf") : "");
export const STORE_DIR = path.resolve(
  process.env.AUTOCERTO_STORE_DIR || path.join(os.homedir(), ".api-anything", "autocerto-store")
);
export const REPO_DIR = STORE_DIR;
export const STORE_JSON_PATH = path.join(STORE_DIR, "conversas-leads.json");
export const STORE_MD_PATH = path.join(STORE_DIR, "conversas-leads.md");
export const LOCKS_DIR = path.join(STORE_DIR, ".locks");
export const REPLY_JOURNAL_PATH = path.join(LOCKS_DIR, "reply-journal.json");

const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_TIMEOUT_MS = 20_000;
const LOCK_POLL_MS = 100;
const DEFAULT_FOLLOWUP_COOLDOWN_MS = 120_000;

const STATUS_NAMES = {
  1: "Pendente",
  2: "Em andamento",
  3: "Agendado",
  4: "Finalizado",
  5: "Em aprovação",
};

const TEMP_NAMES = {
  1: "Frio (1)",
  2: "Morno (2)",
  3: "Quente (3)",
};

const CANAL_NAMES = {
  1: "WhatsApp",
  2: "Messenger",
  3: "Direct Instagram",
  4: "E-mail",
  5: "Chat OLX",
};

export function parseJsonOutput(stdout) {
  const trimmed = String(stdout || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].startsWith("{")) {
        return JSON.parse(lines[i]);
      }
    }
    throw new Error(`Unexpected output: ${trimmed.slice(0, 300)}`);
  }
}

export function normalizeRows(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.columns) && Array.isArray(data.rows)) {
    return data.rows.map((row) => {
      const obj = {};
      for (let i = 0; i < data.columns.length; i++) {
        obj[data.columns[i]] = row[i] ?? null;
      }
      return obj;
    });
  }
  return [];
}

export async function callAutocerto(op, opArgs = {}, { allowWrites = false } = {}) {
  const cliArgs = ["call", "autocerto", op];
  if (allowWrites) {
    cliArgs.push("--json", JSON.stringify(opArgs), "--allow-writes");
  } else {
    for (const [key, val] of Object.entries(opArgs)) {
      if (val === undefined || val === null) continue;
      cliArgs.push(`${key}=${val}`);
    }
  }
  try {
    const childEnv = { ...process.env };
    if (OPENSSL_CONF_DEFAULT && fs.existsSync(OPENSSL_CONF_DEFAULT)) {
      childEnv.OPENSSL_CONF = OPENSSL_CONF_DEFAULT;
    }
    const { stdout } = await execFileAsync("api-anything", cliArgs, {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
      env: childEnv,
    });
    return parseJsonOutput(stdout);
  } catch (err) {
    if (err?.stdout) {
      try {
        return parseJsonOutput(err.stdout);
      } catch {
        // fall through
      }
    }
    throw err;
  }
}

export function loadLeadStore() {
  try {
    const raw = fs.readFileSync(STORE_JSON_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      updatedAt: parsed.updatedAt || null,
      leads: parsed.leads && typeof parsed.leads === "object" ? parsed.leads : {},
    };
  } catch {
    return { updatedAt: null, leads: {} };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid) {
  if (!pid || Number.isNaN(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * Acquires an exclusive filesystem lock by lockName, retrying until timeoutMs
 * and reclaiming locks owned by dead processes or exceeding LOCK_STALE_MS.
 */
export async function withFileLock(lockName, fn, { timeoutMs = LOCK_WAIT_TIMEOUT_MS } = {}) {
  fs.mkdirSync(LOCKS_DIR, { recursive: true });
  const lockPath = path.join(LOCKS_DIR, `${lockName}.lock`);
  const startedAt = Date.now();
  let acquired = false;

  while (!acquired) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }), "utf8");
      fs.closeSync(fd);
      acquired = true;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      try {
        const stat = fs.statSync(lockPath);
        let stale = Date.now() - stat.mtimeMs > LOCK_STALE_MS;
        if (!stale) {
          try {
            const meta = JSON.parse(fs.readFileSync(lockPath, "utf8"));
            if (meta?.pid && !isPidAlive(meta.pid)) {
              stale = true;
            }
          } catch {
            // ignore partial lock read
          }
        }
        if (stale) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timeout waiting for lock: ${lockName}`);
      }
      await sleep(LOCK_POLL_MS);
    }
  }

  try {
    return await fn();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

function loadReplyJournal() {
  try {
    const raw = fs.readFileSync(REPLY_JOURNAL_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveReplyJournal(journal) {
  atomicWrite(REPLY_JOURNAL_PATH, JSON.stringify(journal, null, 2));
}

function normalizeReplyText(text) {
  return String(text || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function isStoreOutgoingItem(item) {
  return !item.EhAgendamento && item.Tipo === 5;
}

/**
 * Returns store outgoing messages (Tipo 5) sent after the latest incoming client message.
 */
export function getStoreRepliesAfterClient(entry) {
  const items = Array.isArray(entry?.items) ? entry.items : [];
  const lastClientId = Number(entry?.lastClientMessageId || 0);
  if (lastClientId > 0) {
    return items.filter((it) => isStoreOutgoingItem(it) && Number(it.Id || 0) > lastClientId);
  }
  return items.filter((it) => isStoreOutgoingItem(it));
}

/**
 * Returns true when the lead has an incoming client/campaign item with no subsequent store reply.
 */
export function hasUnansweredClientMessage(entry) {
  const items = Array.isArray(entry?.items) ? entry.items : [];
  const hasClientOrTeor = items.some((it) => it.Chave === "teor" || isClientIncomingItem(it));
  if (!hasClientOrTeor) return false;
  return getStoreRepliesAfterClient(entry).length === 0;
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
}

function itemRoleLabel(item) {
  if (item.EhAgendamento) return "AGENDAMENTO";
  if (item.Chave === "teor") return "CAMPANHA/ANÚNCIO";
  switch (item.Tipo) {
    case 4:
    case 8:
      return "CLIENTE";
    case 5:
      return item.Autor ? `LOJA (${item.Autor.trim()})` : "LOJA";
    case 3:
    case 10:
      return item.Autor ? `NOTA INTERNA (${item.Autor.trim()})` : "NOTA INTERNA";
    default:
      return item.Autor ? `SISTEMA (${item.Autor.trim()})` : "SISTEMA";
  }
}

function isClientIncomingItem(item) {
  return !item.EhAgendamento && (item.Tipo === 4 || item.Tipo === 8);
}

function sortItemsChronologically(items) {
  return [...items].sort((a, b) => {
    if (a.Chave === "teor" && b.Chave !== "teor") return -1;
    if (b.Chave === "teor" && a.Chave !== "teor") return 1;
    const da = String(a.Data || "");
    const db = String(b.Data || "");
    if (da !== db) return da < db ? -1 : 1;
    return Number(a.Id || 0) - Number(b.Id || 0);
  });
}

export function renderStoreMarkdown(store) {
  const entries = Object.values(store.leads).sort((a, b) => {
    const da = String(a.info?.dataUltimoAndamento || a.info?.dataLead || "");
    const db = String(b.info?.dataUltimoAndamento || b.info?.dataLead || "");
    return da > db ? -1 : da < db ? 1 : Number(b.id) - Number(a.id);
  });

  const lines = [
    "# Conversas e Informações Completas dos Leads (AutoCerto)",
    "",
    `> **Última sincronização:** \`${store.updatedAt || new Date().toISOString()}\` · **Leads arquivados:** \`${entries.length}\``,
    "> **Regra operacional:** Sempre sincronizar e ler **toda a conversa e os dados do lead** neste arquivo antes de responder, garantindo que nenhuma mensagem intermediária passe batido.",
    "",
    "---",
    "",
  ];

  for (const leadEntry of entries) {
    const info = leadEntry.info || {};
    const veiculoStr = info.idVeiculo
      ? `[Estoque #${info.idVeiculo}] ${[info.veiculoMarca, info.veiculoModelo, info.veiculoVersao].filter(Boolean).join(" ")} (${info.anoFabricacao || "?"}/${info.anoModelo || "?"}) · Placa: ${info.placa || "-"} · Preço: ${info.precoAtual ? `R$ ${Number(info.precoAtual).toLocaleString("pt-BR")}` : "-"}`
      : info.veiculoLead
      ? `[Manual/Fora do estoque] ${info.veiculoLead}`
      : "Sem veículo marcado (null)";

    const statusStr = STATUS_NAMES[info.status] || String(info.status ?? "-");
    const tempStr = TEMP_NAMES[info.termometro] || String(info.termometro ?? "-");
    const canaisStr = Array.isArray(info.canais) && info.canais.length
      ? info.canais.map((c) => CANAL_NAMES[c] || c).join(", ")
      : "-";

    lines.push(`## Lead \`${leadEntry.id}\` — ${info.nome || "Sem nome"}`);
    lines.push(`- **Telefone:** \`${info.telefone || "-"}\`${info.telefone2 ? ` / \`${info.telefone2}\`` : ""} · **E-mail:** \`${info.email || "-"}\``);
    lines.push(`- **CPF:** \`${info.cpf || "não informado"}\` · **Nascimento:** \`${info.dataNascimento || "não informado"}\` · **Deseja Financiamento:** \`${info.desejaFinanciamento ?? "não informado"}\``);
    lines.push(`- **Mídia:** \`${info.midia || "-"}\` · **Interesse:** \`${info.interesse || "-"}\` · **Responsável:** \`${(info.responsavel || "-").trim()}\``);
    lines.push(`- **Status:** \`${statusStr}\`${info.subStatus ? ` (\`${info.subStatus}\`)` : ""} · **Termômetro:** \`${tempStr}\` · **Janela WhatsApp:** \`${info.estadoWhatsapp || "-"}\` · **Canais:** \`${canaisStr}\``);
    lines.push(`- **Data do Lead:** \`${info.dataLead || "-"}\` · **Último Andamento:** \`${info.dataUltimoAndamento || "-"}\` · **Agendamento:** \`${info.dataAgendamento || "nenhum"}\``);
    lines.push(`- **Veículo no Card:** ${veiculoStr}`);
    if (Array.isArray(info.veiculosInteresse) && info.veiculosInteresse.length > 0) {
      lines.push(`- **Veículos de Interesse Extras:** \`${JSON.stringify(info.veiculosInteresse)}\``);
    }
    if (info.teor || info.teorAnexoUrl || info.teorAnexoTitulo) {
      lines.push(`- **Campanha / Teor Inicial:** ${info.teor ? `"${info.teor}"` : "(sem texto)"}${info.teorAnexoTitulo ? ` · Título: \`${info.teorAnexoTitulo}\`` : ""}${info.teorAnexoUrl ? ` · Link: ${info.teorAnexoUrl}` : ""}`);
    }
    lines.push(`- **Último ID de Mensagem do Cliente:** \`${leadEntry.lastClientMessageId ?? "nenhum"}\` · **Total de Interações:** \`${(leadEntry.items || []).length}\` · **Sincronizado em:** \`${leadEntry.syncedAt}\``);
    lines.push("");
    lines.push("### Histórico Completo da Conversa");

    const items = leadEntry.items || [];
    if (items.length === 0) {
      lines.push("*(Nenhuma mensagem trocada ainda.)*");
    } else {
      for (const it of items) {
        const role = itemRoleLabel(it);
        const canal = it.Canal ? ` · ${CANAL_NAMES[it.Canal] || `Canal ${it.Canal}`}` : "";
        const idTag = it.Id ? ` [id:${it.Id}]` : "";
        const textBody = (it.Texto || "").trim();
        const attachParts = [];
        if (it.AnexoTipo) attachParts.push(`tipo=${it.AnexoTipo}`);
        if (it.AnexoTitulo) attachParts.push(`título="${it.AnexoTitulo}"`);
        if (it.AnexoUrl) attachParts.push(`url=${it.AnexoUrl}`);
        if (it.AgendaQuando) attachParts.push(`agenda=${it.AgendaQuando}`);
        const attachStr = attachParts.length ? ` *(Anexo: ${attachParts.join(", ")})*` : "";

        lines.push(`- **[\`${it.Data || "-"}\`] ${role}${canal}${idTag}:**${attachStr}`);
        if (textBody) {
          for (const tl of textBody.split(/\r?\n/)) {
            lines.push(`  > ${tl}`);
          }
        }
      }
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

export function saveLeadStore(store) {
  store.updatedAt = new Date().toISOString();
  atomicWrite(STORE_JSON_PATH, JSON.stringify(store, null, 2));
  atomicWrite(STORE_MD_PATH, renderStoreMarkdown(store));
}

function parseCursorPair(cursorStr) {
  const parts = String(cursorStr || "").split("-");
  return {
    msgId: Number(parts[0] || 0) || 0,
    agId: Number(parts[1] || 0) || 0,
  };
}

export async function fetchAllConversationPages(leadId) {
  const allByKey = new Map();
  let cursor = "";
  let cursorNovas = null;
  let pages = 0;

  // 1. Fetch initial page and walk backwards (antes=cursor)
  while (pages < 25) {
    pages += 1;
    const args = cursor ? { id: leadId, antes: cursor } : { id: leadId };
    const res = await callAutocerto("getLeadConversation", args);
    if (!res.ok) {
      return res;
    }
    const conv = res.data || {};
    if (conv.CursorNovas) {
      cursorNovas = conv.CursorNovas;
    }
    const itens = Array.isArray(conv.Itens) ? conv.Itens : [];
    for (const it of itens) {
      const key = it.Chave || `${it.EhAgendamento ? "a" : "i"}${it.Id}`;
      allByKey.set(key, { ...it, Chave: key });
    }
    if (!conv.TemAnteriores || !conv.Cursor || conv.Cursor === cursor || itens.length === 0) {
      break;
    }
    cursor = conv.Cursor;
  }

  // 2. Walk forwards using getLeadNewMessages(depois=maxMsgId-maxAgId) whenever
  //    CursorNovas indicates newer messages exist beyond what getLeadConversation returned.
  let forwardPages = 0;
  let prevDepois = null;
  while (forwardPages < 25) {
    let maxMsgId = 0;
    let maxAgId = 0;
    for (const it of allByKey.values()) {
      const idNum = Number(it.Id || 0);
      if (it.EhAgendamento) {
        if (idNum > maxAgId) maxAgId = idNum;
      } else if (idNum > maxMsgId) {
        maxMsgId = idNum;
      }
    }

    const target = parseCursorPair(cursorNovas);
    const hasNewerByCursor = target.msgId > maxMsgId || target.agId > maxAgId;
    if (!hasNewerByCursor) {
      break;
    }

    const depois = `${maxMsgId}-${maxAgId}`;
    if (depois === prevDepois) {
      break;
    }
    prevDepois = depois;
    forwardPages += 1;

    const newRes = await callAutocerto("getLeadNewMessages", { id: leadId, depois });
    if (!newRes.ok) {
      return newRes;
    }
    const newConv = newRes.data || {};
    if (newConv.CursorNovas) {
      cursorNovas = newConv.CursorNovas;
    }
    const newItens = Array.isArray(newConv.Itens) ? newConv.Itens : [];
    let added = 0;
    for (const it of newItens) {
      const key = it.Chave || `${it.EhAgendamento ? "a" : "i"}${it.Id}`;
      if (!allByKey.has(key)) added += 1;
      allByKey.set(key, { ...it, Chave: key });
    }
    if (newItens.length === 0 || added === 0) {
      break;
    }
  }

  return {
    ok: true,
    items: sortItemsChronologically([...allByKey.values()]),
    cursorNovas,
    pagesFetched: pages + forwardPages,
  };
}

export async function syncLeadToStore(leadId, { store = null, persist = true } = {}) {
  const idNum = Number(leadId);
  const idKey = String(idNum);

  const [detailsRes, convRes] = await Promise.all([
    callAutocerto("getLeadDetails", { id: idNum }),
    fetchAllConversationPages(idNum),
  ]);

  if (!detailsRes.ok) return detailsRes;
  if (!convRes.ok) return convRes;

  const buildAndOptionallyPersist = () => {
    const activeStore = store || loadLeadStore();
    const d = detailsRes.data || {};
    const prevLead = activeStore.leads[idKey] || { items: [] };

    const mergedByKey = new Map();
    for (const oldItem of prevLead.items || []) {
      if (oldItem?.Chave) mergedByKey.set(oldItem.Chave, oldItem);
    }

    if (d.Teor || d.TeorAnexoUrl || d.TeorAnexoImagem) {
      mergedByKey.set("teor", {
        Id: 0,
        Chave: "teor",
        EhAgendamento: false,
        Data: d.DataLead || null,
        Tipo: 4,
        Canal: null,
        Texto: d.Teor || null,
        Autor: null,
        AnexoTipo: d.TeorAnexoImagem || d.TeorAnexoUrl ? "campanha" : null,
        AnexoUrl: d.TeorAnexoUrl || null,
        AnexoTitulo: d.TeorAnexoTitulo || null,
      });
    }

    for (const it of convRes.items) {
      const key = it.Chave || `${it.EhAgendamento ? "a" : "i"}${it.Id}`;
      mergedByKey.set(key, {
        Id: it.Id ?? null,
        Chave: key,
        EhAgendamento: Boolean(it.EhAgendamento),
        Data: it.Data ?? null,
        Tipo: it.Tipo ?? null,
        Canal: it.Canal ?? null,
        Texto: it.Texto ?? null,
        IdAutor: it.IdAutor ?? null,
        Autor: it.Autor ?? null,
        StatusEntrega: it.StatusEntrega ?? null,
        MotivoFalha: it.MotivoFalha ?? null,
        AnexoUrl: it.AnexoUrl ?? null,
        AnexoTipo: it.AnexoTipo ?? null,
        AnexoTitulo: it.AnexoTitulo ?? null,
        AgendaQuando: it.AgendaQuando ?? null,
        AgendaStatus: it.AgendaStatus ?? null,
        AgendaFinalizado: it.AgendaFinalizado ?? null,
      });
    }

    const sortedItems = sortItemsChronologically([...mergedByKey.values()]);
    const clientItems = sortedItems.filter((it) => it.Chave !== "teor" && isClientIncomingItem(it));
    const lastClientItem = clientItems.length > 0 ? clientItems[clientItems.length - 1] : null;
    const lastAnyItem = sortedItems.length > 0 ? sortedItems[sortedItems.length - 1] : null;

    const entry = {
      id: idNum,
      syncedAt: new Date().toISOString(),
      cursorNovas: convRes.cursorNovas || null,
      lastItemId: lastAnyItem?.Id ?? 0,
      lastClientMessageId: lastClientItem?.Id ?? 0,
      lastClientMessageAt: lastClientItem?.Data ?? d.DataLead ?? null,
      info: {
        idLead: d.IdLead ?? idNum,
        nome: d.Nome ?? null,
        telefone: d.Telefone ?? null,
        telefone2: d.Telefone2 ?? null,
        email: d.Email ?? null,
        cpf: d.Cpf ?? null,
        dataNascimento: d.DataNascimento ?? null,
        cidade: d.Cidade ?? null,
        bairro: d.Bairro ?? null,
        melhorHorario: d.MelhorHorario ?? null,
        desejaFinanciamento: d.DesejaFinanciamento ?? null,
        midia: d.Midia ?? null,
        interesse: d.Interesse ?? null,
        status: d.Status ?? null,
        subStatus: d.SubStatus ?? null,
        termometro: d.Termometro ?? null,
        responsavel: d.Responsavel ?? null,
        interno: Boolean(d.Interno),
        estadoWhatsapp: d.EstadoWhatsapp ?? null,
        canais: d.Canais ?? [],
        dataLead: d.DataLead ?? null,
        dataUltimoAndamento: d.DataUltimoAndamento ?? null,
        dataAgendamento: d.DataAgendamento ?? null,
        idVeiculo: d.IdVeiculo ?? null,
        veiculoMarca: d.VeiculoMarca ?? null,
        veiculoModelo: d.VeiculoModelo ?? null,
        veiculoVersao: d.VeiculoVersao ?? null,
        anoFabricacao: d.AnoFabricacao ?? null,
        anoModelo: d.AnoModelo ?? null,
        placa: d.Placa ?? null,
        precoAtual: d.PrecoAtual ?? null,
        reservado: Boolean(d.Reservado),
        veiculoLead: d.VeiculoLead ?? null,
        veiculosInteresse: d.VeiculosInteresse ?? [],
        teor: d.Teor ?? null,
        teorAnexoTitulo: d.TeorAnexoTitulo ?? null,
        teorAnexoUrl: d.TeorAnexoUrl ?? null,
      },
      items: sortedItems,
    };

    activeStore.leads[idKey] = entry;
    if (persist) {
      saveLeadStore(activeStore);
    }

    return {
      ok: true,
      entry,
      storeJsonPath: STORE_JSON_PATH,
      storeMdPath: STORE_MD_PATH,
    };
  };

  if (persist && !store) {
    return await withFileLock("lead-store", buildAndOptionallyPersist);
  }
  return buildAndOptionallyPersist();
}

/**
 * Evaluates all pre-send anti-race and anti-duplicate guards against a synced lead entry
 * and the local reply journal. Exported so both runtime sends and unit tests share one path.
 */
export function evaluateReplyGuards({
  entry,
  expectedLastClientMessageId,
  texto,
  templateId = null,
  allowFollowup = false,
  force = false,
  cooldownMs = DEFAULT_FOLLOWUP_COOLDOWN_MS,
  journal = null,
  nowMs = Date.now(),
}) {
  const idKey = String(entry?.id ?? "");
  const actualLastClientId = Number(entry?.lastClientMessageId || 0);
  const expectedId = Number(expectedLastClientMessageId);

  if (Number.isNaN(expectedId) || actualLastClientId !== expectedId) {
    const unseenClientMessages = (entry?.items || []).filter(
      (it) => it.Chave !== "teor" && isClientIncomingItem(it) && Number(it.Id || 0) > expectedId
    );
    return {
      allowed: false,
      reason: "new_client_message_detected_before_send",
      expectedLastClientMessageId: expectedId,
      actualLastClientMessageId: actualLastClientId,
      unseenClientMessages,
      leadInfo: entry?.info,
    };
  }

  const storeRepliesAfterClient = getStoreRepliesAfterClient(entry);
  if (!force && !allowFollowup && storeRepliesAfterClient.length > 0) {
    return {
      allowed: false,
      reason: "already_replied_after_client_message",
      expectedLastClientMessageId: expectedId,
      actualLastClientMessageId: actualLastClientId,
      existingStoreReplies: storeRepliesAfterClient,
      leadInfo: entry?.info,
    };
  }

  const normalizedText = templateId ? `template:${templateId}` : normalizeReplyText(texto);
  const activeJournal = journal || loadReplyJournal();
  const prevRecord = activeJournal[idKey];
  if (!force && prevRecord) {
    if (!allowFollowup && Number(prevRecord.lastRepliedClientMessageId) === actualLastClientId) {
      return {
        allowed: false,
        reason: "already_replied_in_local_journal",
        expectedLastClientMessageId: expectedId,
        actualLastClientMessageId: actualLastClientId,
        previousReplyRecord: prevRecord,
      };
    }
    const elapsedMs = nowMs - Number(prevRecord.sentAt || 0);
    if (elapsedMs < cooldownMs) {
      return {
        allowed: false,
        reason: "duplicate_cooldown_active",
        elapsedMs,
        cooldownMs,
        previousReplyRecord: prevRecord,
      };
    }
    if (prevRecord.normalizedText === normalizedText) {
      return {
        allowed: false,
        reason: "duplicate_text_matches_journal",
        previousReplyRecord: prevRecord,
      };
    }
  }

  if (!force && storeRepliesAfterClient.length > 0) {
    const lastStoreMsg = storeRepliesAfterClient[storeRepliesAfterClient.length - 1];
    if (normalizeReplyText(lastStoreMsg?.Texto) === normalizedText) {
      return {
        allowed: false,
        reason: "duplicate_text_matches_last_store_message",
        lastStoreMessage: lastStoreMsg,
      };
    }
  }

  return {
    allowed: true,
    actualLastClientId,
    normalizedText,
  };
}

export async function safeReplyLead({
  id,
  expectedLastClientMessageId,
  texto,
  canal = 1,
  templateId = null,
  allowFollowup = false,
  force = false,
  cooldownMs = DEFAULT_FOLLOWUP_COOLDOWN_MS,
}) {
  const idNum = Number(id);
  const idKey = String(idNum);

  return await withFileLock(`reply-lead-${idNum}`, async () => {
    // 1. Mandatory pre-send full sync from AutoCerto into persistent file
    const preSync = await syncLeadToStore(idNum);
    if (!preSync.ok) {
      return { ok: false, stage: "pre_sync", error: preSync };
    }

    // 2. Anti-race & anti-duplicate guards
    const journal = loadReplyJournal();
    const guard = evaluateReplyGuards({
      entry: preSync.entry,
      expectedLastClientMessageId,
      texto,
      templateId,
      allowFollowup,
      force,
      cooldownMs,
      journal,
    });
    if (!guard.allowed) {
      const { allowed: _allowed, ...details } = guard;
      return {
        ok: false,
        aborted: true,
        ...details,
        storeMdPath: STORE_MD_PATH,
      };
    }

    // 3. Send reply or approved template
    const sendRes = templateId
      ? await callAutocerto(
          "sendWhatsappTemplate",
          { id: idNum, modelo: Number(templateId) },
          { allowWrites: true }
        )
      : await callAutocerto(
          "replyLead",
          { id: idNum, canal: Number(canal), texto: String(texto) },
          { allowWrites: true }
        );

    if (!sendRes.ok) {
      return { ok: false, stage: "send", error: sendRes };
    }

    // 4. Persist local idempotency record immediately after confirmed send
    journal[idKey] = {
      lastRepliedClientMessageId: guard.actualLastClientId,
      sentAt: Date.now(),
      sentAtIso: new Date().toISOString(),
      canal: Number(canal),
      templateId: templateId ? Number(templateId) : null,
      normalizedText: guard.normalizedText,
    };
    saveReplyJournal(journal);

    // 5. Mandatory post-send sync to persist our sent message and catch any simultaneous incoming message
    const postSync = await syncLeadToStore(idNum);
    const postLastClientId = Number(postSync.entry?.lastClientMessageId || guard.actualLastClientId);
    const arrivedDuringSend =
      postLastClientId > guard.actualLastClientId
        ? (postSync.entry?.items || []).filter(
            (it) => it.Chave !== "teor" && isClientIncomingItem(it) && Number(it.Id || 0) > guard.actualLastClientId
          )
        : [];

    return {
      ok: true,
      writeResult: sendRes.data || sendRes,
      lastClientMessageIdBeforeSend: guard.actualLastClientId,
      lastClientMessageIdAfterSend: postLastClientId,
      arrivedDuringSend,
      totalConversationItems: postSync.entry?.items?.length || preSync.entry.items.length,
      storeMdPath: STORE_MD_PATH,
      storeJsonPath: STORE_JSON_PATH,
    };
  });
}

// CLI entrypoint
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const cmd = process.argv[2];
  (async () => {
    if (cmd === "sync") {
      const ids = process.argv.slice(3).map(Number).filter(Boolean);
      if (ids.length === 0) {
        console.error("Usage: node lead-store.mjs sync <id1> [id2 ...]");
        process.exit(1);
      }
      const results = await withFileLock("lead-store", async () => {
        const store = loadLeadStore();
        const synced = [];
        for (const id of ids) {
          const r = await syncLeadToStore(id, { store, persist: false });
          if (!r.ok) {
            console.error(JSON.stringify(r));
            process.exit(1);
          }
          synced.push({
            id,
            nome: r.entry.info.nome,
            carro: r.entry.info.veiculoModelo
              ? `${r.entry.info.veiculoMarca} ${r.entry.info.veiculoModelo}`
              : r.entry.info.veiculoLead,
            needsReply: hasUnansweredClientMessage(r.entry),
            totalItems: r.entry.items.length,
            lastClientMessageId: r.entry.lastClientMessageId,
            lastClientMessageAt: r.entry.lastClientMessageAt,
          });
        }
        saveLeadStore(store);
        return synced;
      });
      console.log(
        JSON.stringify({
          ok: true,
          synced: results,
          storeMdPath: STORE_MD_PATH,
          storeJsonPath: STORE_JSON_PATH,
        })
      );
    } else if (cmd === "reply") {
      const payloadRaw = process.argv[3];
      if (!payloadRaw) {
        console.error('Usage: node lead-store.mjs reply \'{"id":...,"expectedLastClientMessageId":...,"texto":"..."}\'');
        process.exit(1);
      }
      const payload = JSON.parse(payloadRaw);
      const res = await safeReplyLead(payload);
      console.log(JSON.stringify(res));
      process.exit(res.ok ? 0 : 2);
    } else {
      console.error("Commands: sync | reply");
      process.exit(1);
    }
  })().catch((err) => {
    console.error(JSON.stringify({ ok: false, error: err?.message || String(err) }));
    process.exit(1);
  });
}
