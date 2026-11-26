import assert from "node:assert/strict";
import {
  evaluateReplyGuards,
  getStoreRepliesAfterClient,
  hasUnansweredClientMessage,
  withFileLock,
} from "./lead-store.mjs";

// 1. Reproduces duplicate reply after client message when store already replied
const afterFirstStoreReply = {
  id: 100001,
  lastClientMessageId: 200002,
  info: { nome: "Cliente Exemplo" },
  items: [
    { Id: 0, Chave: "teor", EhAgendamento: false, Tipo: 4, Texto: "Tenho interesse no veículo anunciado" },
    { Id: 200001, EhAgendamento: false, Tipo: 5, Texto: "Olá, Cliente Exemplo!" },
    { Id: 200002, EhAgendamento: false, Tipo: 4, Texto: "Quero financiar" },
    { Id: 200003, EhAgendamento: false, Tipo: 5, Texto: "Perfeito! Me passa CPF e data de nascimento..." },
  ],
};

assert.equal(getStoreRepliesAfterClient(afterFirstStoreReply).length, 1);
assert.equal(hasUnansweredClientMessage(afterFirstStoreReply), false);

const guardDuplicate = evaluateReplyGuards({
  entry: afterFirstStoreReply,
  expectedLastClientMessageId: 200002,
  texto: "Perfeito! Faço a simulação...",
  journal: {},
});
assert.equal(guardDuplicate.allowed, false);
assert.equal(guardDuplicate.reason, "already_replied_after_client_message");

// 2. Client replied again (200004) -> allowed
const withNewClientReply = {
  ...afterFirstStoreReply,
  lastClientMessageId: 200004,
  items: [
    ...afterFirstStoreReply.items,
    { Id: 200004, EhAgendamento: false, Tipo: 4, Texto: "00000000000\n01/01/1990\nSem entrada" },
  ],
};
assert.equal(hasUnansweredClientMessage(withNewClientReply), true);

const guardAllowed = evaluateReplyGuards({
  entry: withNewClientReply,
  expectedLastClientMessageId: 200004,
  texto: "Recebido! Já vou rodar sua simulação.",
  journal: {},
});
assert.equal(guardAllowed.allowed, true);

// 3. Stale expectedLastClientMessageId -> blocked (new_client_message_detected_before_send)
const guardRace = evaluateReplyGuards({
  entry: withNewClientReply,
  expectedLastClientMessageId: 200002,
  texto: "Texto antigo",
  journal: {},
});
assert.equal(guardRace.allowed, false);
assert.equal(guardRace.reason, "new_client_message_detected_before_send");
assert.equal(guardRace.unseenClientMessages.length, 1);

// 4. Local journal blocks rapid retry even before AutoCerto lists the sent item
const now = Date.now();
const guardJournal = evaluateReplyGuards({
  entry: withNewClientReply,
  expectedLastClientMessageId: 200004,
  texto: "Recebido! Já vou rodar sua simulação.",
  journal: {
    "100001": {
      lastRepliedClientMessageId: 200004,
      sentAt: now - 2000,
      normalizedText: "recebido! já vou rodar sua simulação.",
    },
  },
  nowMs: now,
});
assert.equal(guardJournal.allowed, false);
assert.equal(guardJournal.reason, "already_replied_in_local_journal");

// 5. Followup mode blocks within cooldown, allows after cooldown with new text
const guardCooldown = evaluateReplyGuards({
  entry: afterFirstStoreReply,
  expectedLastClientMessageId: 200002,
  texto: "Oi, conseguiu ver minha mensagem?",
  allowFollowup: true,
  journal: {
    "100001": {
      lastRepliedClientMessageId: 200002,
      sentAt: now - 10_000,
      normalizedText: "perfeito! me passa cpf e data de nascimento...",
    },
  },
  nowMs: now,
});
assert.equal(guardCooldown.allowed, false);
assert.equal(guardCooldown.reason, "duplicate_cooldown_active");

const guardFollowupAllowed = evaluateReplyGuards({
  entry: afterFirstStoreReply,
  expectedLastClientMessageId: 200002,
  texto: "Oi, conseguiu ver minha mensagem?",
  allowFollowup: true,
  journal: {
    "100001": {
      lastRepliedClientMessageId: 200002,
      sentAt: now - 200_000,
      normalizedText: "perfeito! me passa cpf e data de nascimento...",
    },
  },
  nowMs: now,
});
assert.equal(guardFollowupAllowed.allowed, true);

// 6. Exclusive file lock serializes concurrent workers
const trace = [];
await Promise.all([
  withFileLock("test-concurrency", async () => {
    trace.push("A-enter");
    await new Promise((r) => setTimeout(r, 80));
    trace.push("A-exit");
  }),
  withFileLock("test-concurrency", async () => {
    trace.push("B-enter");
    await new Promise((r) => setTimeout(r, 20));
    trace.push("B-exit");
  }),
]);
assert.equal(
  (trace[0] === "A-enter" && trace[1] === "A-exit" && trace[2] === "B-enter" && trace[3] === "B-exit") ||
    (trace[0] === "B-enter" && trace[1] === "B-exit" && trace[2] === "A-enter" && trace[3] === "A-exit"),
  true,
  `Unexpected lock interleaving: ${JSON.stringify(trace)}`
);

console.log(JSON.stringify({ ok: true, testsPassed: 6 }));
