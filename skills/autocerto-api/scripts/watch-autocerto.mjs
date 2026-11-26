import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  callAutocerto,
  hasUnansweredClientMessage,
  loadLeadStore,
  normalizeRows,
  STORE_DIR,
  saveLeadStore,
  STORE_JSON_PATH,
  STORE_MD_PATH,
  syncLeadToStore,
  withFileLock,
} from "./lead-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INTERVAL_MS = Number(process.env.WATCH_INTERVAL_MS || 60_000);
const STATE_DIR = path.join(STORE_DIR, ".locks");
const STATE_FILE = process.env.WATCH_STATE_FILE || path.join(STATE_DIR, "watch-state.json");
const PID_FILE = process.env.WATCH_PID_FILE || path.join(STATE_DIR, "watch-autocerto.pid");
const MAX_CONSECUTIVE_ERRORS = 3;

const FOLDER_MONITORS = [
  { counterKey: "Pendente", pasta: "pend" },
  { counterKey: "PrimeiroAtendimento", pasta: "pri" },
  { counterKey: "SemVendedor", pasta: "semv" },
  { counterKey: "SemApoio", pasta: "semapoio" },
  { counterKey: "AgendadosAtrasados", pasta: "agatr" },
];

const COUNT_ONLY_MONITORS = ["PendenteFinalizacao"];

const args = new Set(process.argv.slice(2));
const SEED_MODE = args.has("--seed");
const ONCE_MODE = args.has("--once");
const DRY_CATEGORIZE = args.has("--dry-categorize");

let consecutiveErrors = 0;

function normText(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasWord(haystackNorm, wordNorm) {
  if (!wordNorm) return false;
  const re = new RegExp(`(^|[^A-Z0-9])${escapeRegex(wordNorm)}([^A-Z0-9]|$)`);
  return re.test(haystackNorm);
}

function matchVehicleInStock(texts, stockList) {
  const combinedRaw = texts.filter(Boolean).join(" \n ");
  const text = normText(combinedRaw);
  if (!text.trim() || !Array.isArray(stockList) || stockList.length === 0) {
    return { matched: null, candidates: [], reason: "no_text_or_stock" };
  }

  const compactText = text.replace(/[^A-Z0-9]/g, "");
  for (const v of stockList) {
    const plateCompact = normText(v.placa).replace(/[^A-Z0-9]/g, "");
    if (plateCompact.length >= 7 && compactText.includes(plateCompact)) {
      return { matched: v, candidates: [v], reason: "exact_plate" };
    }
  }

  const modelMatched = stockList.filter((v) => {
    const mod = normText(v.modelo).trim();
    if (!mod) return false;
    if (mod === "HB20" && hasWord(text, "HB20S")) return false;
    if (hasWord(text, mod)) return true;
    const noHyphen = mod.replace(/-/g, " ");
    const compactMod = mod.replace(/-/g, "");
    return hasWord(text, noHyphen) || (compactMod.length >= 4 && hasWord(text, compactMod));
  });

  if (modelMatched.length === 0) {
    return { matched: null, candidates: [], reason: "no_model_mentioned" };
  }

  if (modelMatched.length === 1) {
    return { matched: modelMatched[0], candidates: modelMatched, reason: "unique_model_in_stock" };
  }

  const scored = modelMatched.map((v) => {
    let score = 0;
    const anoMod = String(v.anoModelo || "");
    const anoFab = String(v.anoFabricacao || "");
    if (anoMod && hasWord(text, anoMod)) score += 10;
    else if (anoFab && hasWord(text, anoFab)) score += 8;

    const verTokens = normText(v.versao)
      .split(/[^A-Z0-9.]+/)
      .filter((t) => t.length >= 2 && !["FLEX", "4P", "2P", "8V", "12V", "16V", "DE"].includes(t));

    for (const tok of verTokens) {
      if (hasWord(text, tok)) score += 3;
    }
    if (hasWord(text, "AUTOMATICO") || hasWord(text, "AUT") || hasWord(text, "AT6") || hasWord(text, "CVT")) {
      if (/AUTOMATICO|AT6|CVT/.test(normText(v.versao))) score += 4;
    }
    if (hasWord(text, "MANUAL") && /MANUAL/.test(normText(v.versao))) {
      score += 3;
    }
    return { vehicle: v, score };
  });

  scored.sort((a, b) => b.score - a.score);
  if (scored[0].score > 0 && scored[0].score > scored[1].score) {
    return {
      matched: scored[0].vehicle,
      candidates: scored.map((s) => s.vehicle),
      reason: `scored_match(${scored[0].score}>${scored[1].score})`,
    };
  }

  return {
    matched: null,
    candidates: scored.map((s) => s.vehicle),
    reason: "ambiguous_model_candidates",
  };
}

function leadFingerprint(lead) {
  return [
    lead.dataUltimoAndamento || "",
    lead.status ?? "",
    lead.subStatus ?? "",
    lead.dataAgendamento || "",
    lead.responsavel || "",
  ].join("|");
}

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      updatedAt: parsed.updatedAt || null,
      folders: parsed.folders && typeof parsed.folders === "object" ? parsed.folders : {},
      counters: parsed.counters && typeof parsed.counters === "object" ? parsed.counters : {},
    };
  } catch {
    return { updatedAt: null, folders: {}, counters: {} };
  }
}

function saveState(state) {
  const dir = path.dirname(STATE_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmpFile = `${STATE_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmpFile, STATE_FILE);
}

async function fetchFolderLeads(pasta, expectedCount) {
  const leads = [];
  const maxPages = expectedCount > 25 ? Math.min(4, Math.ceil(expectedCount / 25)) : 1;
  for (let pagina = 1; pagina <= maxPages; pagina++) {
    const res = await callAutocerto("listLeads", { pasta, pagina });
    if (!res.ok) return res;
    const pageRows = normalizeRows(res.data);
    leads.push(...pageRows);
    if (pageRows.length < 25) break;
  }
  return { ok: true, data: leads };
}

function handleApiFailure(res) {
  if (res.class === "auth" || res.class === "blocked") {
    console.log(
      JSON.stringify({
        event: "auth_error",
        at: new Date().toISOString(),
        class: res.class,
        reason: res.reason,
        next: res.next,
      })
    );
    process.exit(2);
  }
  consecutiveErrors += 1;
  if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    console.log(
      JSON.stringify({
        event: "api_error",
        at: new Date().toISOString(),
        consecutiveErrors,
        res,
      })
    );
    process.exit(1);
  }
}

async function fetchStockSafe() {
  try {
    const res = await callAutocerto("searchStockJson", { query: "" });
    if (!res.ok) return [];
    return normalizeRows(res.data);
  } catch {
    return [];
  }
}

function buildLeadSummary(lead) {
  return {
    id: lead.id,
    nome: lead.nome,
    telefone: lead.telefone,
    midia: lead.midia,
    carro: lead.carro,
    versao: lead.versao || null,
    placa: lead.placa || null,
    anoModelo: lead.anoModelo || null,
    preco: lead.preco ?? null,
    termometro: lead.termometro,
    dataUltimoAndamento: lead.dataUltimoAndamento,
    needsVehicleCategorization: !lead.carro,
  };
}

const SETTLE_MS = Number(process.env.WATCH_SETTLE_MS || 4_000);

async function syncAndCategorizeTriggeredLeads(events, allPendingLeads) {
  if (!ONCE_MODE && SETTLE_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  }
  const stockList = await fetchStockSafe();

  const idsToSync = new Set();
  for (const ev of events) {
    if (ev.lead?.id) idsToSync.add(Number(ev.lead.id));
  }
  for (const p of allPendingLeads) {
    if (p.id) idsToSync.add(Number(p.id));
  }

  const enrichmentByLead = await withFileLock("lead-store", async () => {
    const store = loadLeadStore();
    const map = new Map();

    for (const leadId of idsToSync) {
      let synced = await syncLeadToStore(leadId, { store, persist: false });
      if (!synced.ok) continue;

      let entry = synced.entry;
      const info = entry.info || {};
      let autoCategorize = null;

      const currentlyHasVehicle = Boolean(info.idVeiculo || info.veiculoLead);
      if (!currentlyHasVehicle && stockList.length > 0) {
        const clientTextsNewestFirst = (entry.items || [])
          .filter((m) => m.Chave !== "teor" && !m.EhAgendamento && (m.Tipo === 4 || m.Tipo === 8))
          .map((m) => m.Texto)
          .reverse();

        const searchOrder = [
          ...clientTextsNewestFirst,
          info.teor,
          info.teorAnexoTitulo,
        ].filter(Boolean);

        let matchRes = { matched: null, candidates: [], reason: "no_text" };
        for (const textPiece of searchOrder) {
          matchRes = matchVehicleInStock([textPiece], stockList);
          if (matchRes.matched || matchRes.candidates.length > 0) break;
        }
        if (!matchRes.matched && matchRes.candidates.length === 0 && searchOrder.length > 1) {
          matchRes = matchVehicleInStock(searchOrder, stockList);
        }

        if (matchRes.matched) {
          const v = matchRes.matched;
          if (DRY_CATEGORIZE) {
            autoCategorize = {
              applied: false,
              dry: true,
              reason: matchRes.reason,
              vehicle: v,
            };
          } else {
            try {
              const writeRes = await callAutocerto(
                "updateLeadVehicle",
                { id: Number(leadId), idVeiculo: Number(v.id) },
                { allowWrites: true }
              );
              autoCategorize = {
                applied: Boolean(writeRes?.ok),
                reason: matchRes.reason,
                vehicle: v,
                writeResponse: writeRes?.data || null,
              };
              if (writeRes?.ok) {
                const resynced = await syncLeadToStore(leadId, { store, persist: false });
                if (resynced.ok) entry = resynced.entry;
              }
            } catch (err) {
              autoCategorize = {
                applied: false,
                reason: matchRes.reason,
                vehicle: v,
                error: err?.message || String(err),
              };
            }
          }
        } else {
          autoCategorize = {
            applied: false,
            reason: matchRes.reason,
            candidates: matchRes.candidates.slice(0, 5),
          };
        }
      }

      map.set(leadId, {
        entry,
        autoCategorize,
      });
    }

    saveLeadStore(store);
    return map;
  });

  for (const ev of events) {
    const info = ev.lead?.id ? enrichmentByLead.get(Number(ev.lead.id)) : null;
    if (info) {
      const e = info.entry;
      ev.lastClientMessageId = e.lastClientMessageId;
      ev.needsReply = hasUnansweredClientMessage(e);
      ev.totalConversationItems = e.items.length;
      ev.lastMessage = e.items.length > 0 ? e.items[e.items.length - 1] : null;
      ev.fullConversation = e.items;
      ev.details = e.info;
      ev.autoCategorize = info.autoCategorize;
      if (e.info.idVeiculo) {
        ev.lead.carro = [e.info.veiculoMarca, e.info.veiculoModelo, e.info.veiculoVersao]
          .filter(Boolean)
          .join(" ");
        ev.lead.placa = e.info.placa;
        ev.lead.anoModelo = e.info.anoModelo ? String(e.info.anoModelo) : null;
        ev.lead.preco = e.info.precoAtual;
        ev.lead.needsVehicleCategorization = false;
      }
      if (e.info.dataUltimoAndamento) {
        ev.lead.dataUltimoAndamento = e.info.dataUltimoAndamento;
      }
    }
  }

  for (const p of allPendingLeads) {
    const info = enrichmentByLead.get(Number(p.id));
    if (info) {
      p.lastClientMessageId = info.entry.lastClientMessageId;
      p.needsReply = hasUnansweredClientMessage(info.entry);
      p.totalConversationItems = info.entry.items.length;
      p.estadoWhatsapp = info.entry.info.estadoWhatsapp;
    }
  }

  return enrichmentByLead;
}

async function runPoll({ seedOnly = false } = {}) {
  const prevState = loadState();
  const countersRes = await callAutocerto("leadCounters");
  if (!countersRes.ok) {
    handleApiFailure(countersRes);
    return { triggered: false };
  }

  const pastas = countersRes.data?.pastas || {};
  const nextState = {
    updatedAt: new Date().toISOString(),
    folders: {},
    counters: {},
  };

  const events = [];
  let allPendingLeads = [];

  for (const { counterKey, pasta } of FOLDER_MONITORS) {
    const count = Number(pastas[counterKey] || 0);
    const prevFolder = prevState.folders[pasta] || {};

    if (count <= 0) {
      nextState.folders[pasta] = {};
      continue;
    }

    const listRes = await fetchFolderLeads(pasta, count);
    if (!listRes.ok) {
      handleApiFailure(listRes);
      return { triggered: false };
    }
    if (pasta === "pend") {
      allPendingLeads = listRes.data.map(buildLeadSummary);
    }

    const currentFolder = {};
    for (const lead of listRes.data) {
      const idStr = String(lead.id);
      const fp = leadFingerprint(lead);
      currentFolder[idStr] = {
        nome: lead.nome || null,
        telefone: lead.telefone || null,
        midia: lead.midia || null,
        dataUltimoAndamento: lead.dataUltimoAndamento || null,
        fp,
      };

      if (!seedOnly) {
        const prevEntry = prevFolder[idStr];
        if (!prevEntry) {
          events.push({
            type: "new_in_folder",
            pasta,
            counterKey,
            lead: buildLeadSummary(lead),
          });
        } else if (prevEntry.fp !== fp) {
          events.push({
            type: "updated_in_folder",
            pasta,
            counterKey,
            previousAt: prevEntry.dataUltimoAndamento,
            lead: buildLeadSummary(lead),
          });
        }
      }
    }

    nextState.folders[pasta] = currentFolder;
  }

  for (const counterKey of COUNT_ONLY_MONITORS) {
    const count = Number(pastas[counterKey] || 0);
    const prevCount = Number(prevState.counters[counterKey] || 0);
    nextState.counters[counterKey] = count;

    if (!seedOnly && count > prevCount) {
      events.push({
        type: "counter_increased",
        counterKey,
        previousCount: prevCount,
        currentCount: count,
      });
    }
  }

  consecutiveErrors = 0;
  saveState(nextState);

  if (seedOnly) {
    console.log(
      JSON.stringify({
        event: "seeded",
        at: nextState.updatedAt,
        stateFile: STATE_FILE,
        pastas,
      })
    );
    return { triggered: true };
  }

  if (events.length > 0) {
    const enrichmentByLead = await syncAndCategorizeTriggeredLeads(events, allPendingLeads);

    // Refresh saved fingerprints if autoCategorize updated DataUltimoAndamento on the server
    let stateMutated = false;
    for (const folderMap of Object.values(nextState.folders)) {
      for (const [idStr, saved] of Object.entries(folderMap)) {
        const info = enrichmentByLead.get(Number(idStr));
        const d = info?.entry?.info;
        if (info?.autoCategorize?.applied && d) {
          saved.dataUltimoAndamento = d.dataUltimoAndamento || saved.dataUltimoAndamento;
          saved.fp = leadFingerprint({
            dataUltimoAndamento: d.dataUltimoAndamento,
            status: d.status,
            subStatus: d.subStatus,
            dataAgendamento: d.dataAgendamento,
            responsavel: d.responsavel,
          });
          stateMutated = true;
        }
      }
    }
    if (stateMutated) {
      saveState(nextState);
    }

    console.log(
      JSON.stringify({
        event: "activity_detected",
        at: nextState.updatedAt,
        storeMdPath: STORE_MD_PATH,
        storeJsonPath: STORE_JSON_PATH,
        events,
        allPendingLeads,
        pastas,
        chegaramHoje: countersRes.data?.chegaramHoje || null,
      })
    );
    return { triggered: true };
  }

  return { triggered: false, pastas };
}

async function checkOnce() {
  try {
    const outcome = await runPoll({ seedOnly: SEED_MODE });
    if (SEED_MODE || outcome.triggered) {
      process.exit(0);
    }
    if (ONCE_MODE) {
      console.log(
        JSON.stringify({
          event: "no_changes",
          at: new Date().toISOString(),
          pastas: outcome.pastas,
        })
      );
      process.exit(0);
    }
  } catch (err) {
    consecutiveErrors += 1;
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      console.log(
        JSON.stringify({
          event: "watcher_error",
          at: new Date().toISOString(),
          consecutiveErrors,
          message: err?.message || String(err),
        })
      );
      process.exit(1);
    }
    if (SEED_MODE || ONCE_MODE) {
      console.log(
        JSON.stringify({
          event: "watcher_error",
          at: new Date().toISOString(),
          message: err?.message || String(err),
        })
      );
      process.exit(1);
    }
  }

  setTimeout(checkOnce, INTERVAL_MS);
}

function acquireWatcherPidLock() {
  if (SEED_MODE || ONCE_MODE) return;
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  try {
    const existingPid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
    if (existingPid && existingPid !== process.pid) {
      try {
        process.kill(existingPid, 0);
        console.log(
          JSON.stringify({
            event: "watcher_already_running",
            at: new Date().toISOString(),
            existingPid,
            pidFile: PID_FILE,
          })
        );
        process.exit(0);
      } catch (err) {
        if (err?.code === "EPERM") {
          console.log(
            JSON.stringify({
              event: "watcher_already_running",
              at: new Date().toISOString(),
              existingPid,
              pidFile: PID_FILE,
            })
          );
          process.exit(0);
        }
      }
    }
  } catch {
    // no previous pid file
  }
  fs.writeFileSync(PID_FILE, String(process.pid), "utf8");
  const cleanup = () => {
    try {
      const cur = Number(fs.readFileSync(PID_FILE, "utf8").trim());
      if (cur === process.pid) fs.rmSync(PID_FILE, { force: true });
    } catch {
      // ignore
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
}

acquireWatcherPidLock();
checkOnce();
