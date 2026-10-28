import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createGmailMcp } from "../bin/gmail-mcp.mjs";

const ALL = "[Gmail]/Todos";
const DRAFTS = "[Gmail]/Borradores";
const INBOX = "Bandeja de entrada";

const folders = [
  { path: "INBOX", specialUse: "\\Inbox" },
  { path: ALL, specialUse: "\\All" },
  { path: DRAFTS, specialUse: "\\Drafts" },
  { path: "[Gmail]/Enviados", specialUse: "\\Sent" },
];

function rawMessage({ from = "Ana <ana@example.com>", to = "me@example.com", subject = "Hola", messageId = "abc@example.com", references = "", body = "Hola mundo" } = {}) {
  const lines = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`];
  if (messageId) lines.push(`Message-ID: <${messageId}>`);
  if (references) lines.push(`References: ${references}`);
  lines.push("Date: Tue, 21 Oct 2026 10:00:00 +0000", "Content-Type: text/plain; charset=utf-8", "", body);
  return Buffer.from(lines.join("\r\n"), "utf8");
}

function message({ uid, threadId = "100", subject = "Hola", source, flags = new Set(), labels = ["\\Inbox"], internalDate = new Date("2026-10-21T10:00:00Z"), from = "Ana <ana@example.com>" }) {
  return {
    uid,
    threadId,
    flags,
    labels,
    internalDate,
    envelope: { from: [{ name: "Ana", address: "ana@example.com" }], to: [{ name: "", address: "me@example.com" }], subject },
    source: source || rawMessage({ subject }),
  };
}

function fakeImap({ store = [], searchResult = () => [], folderList = folders, connectError = null } = {}) {
  const fake = {
    usable: false,
    selected: "",
    calls: [],
    appended: [],
    flagAdds: [],
    flagRemoves: [],
    async connect() {
      if (connectError) throw connectError;
      this.usable = true;
      this.calls.push(["connect"]);
    },
    async list() {
      this.calls.push(["list"]);
      return folderList;
    },
    async mailboxOpen(path) {
      this.selected = path;
      this.calls.push(["mailboxOpen", path]);
    },
    async search(query, options) {
      this.calls.push(["search", this.selected, query, options]);
      return searchResult(query);
    },
    async fetchAll(range, query, options) {
      this.calls.push(["fetchAll", this.selected, range, query, options]);
      const wanted = new Set((Array.isArray(range) ? range : [range]).map(String));
      return store.filter((item) => wanted.has(String(item.uid)));
    },
    async fetchOne(uid, query, options) {
      this.calls.push(["fetchOne", this.selected, String(uid), query, options]);
      return store.find((item) => String(item.uid) === String(uid)) || false;
    },
    async append(path, content, flags) {
      this.appended.push({ path, content, flags });
      this.calls.push(["append", path, flags]);
      return true;
    },
    async messageFlagsAdd(range, flags, options) {
      this.flagAdds.push({ range, flags, options });
    },
    async messageFlagsRemove(range, flags, options) {
      this.flagRemoves.push({ range, flags, options });
    },
    async logout() {
      this.usable = false;
      this.calls.push(["logout"]);
    },
    close() {
      this.usable = false;
    },
  };
  return fake;
}

function fakeSmtp() {
  const sent = [];
  return {
    sent,
    async sendMail(options) {
      sent.push(options);
      return { messageId: "<sent@example.com>" };
    },
    close() {},
  };
}

function connect({ env = {}, imap, imaps, smtp } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  let buffer = "";
  output.on("data", (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      lines.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
  });
  const imapFactory = imaps ? () => imaps.shift() : imap ? () => imap : () => {
    throw new Error("imapFactory should not be called");
  };
  const smtpFactory = smtp ? () => smtp : () => {
    throw new Error("smtpFactory should not be called");
  };
  const { closed } = createGmailMcp({ input, output, env, imapFactory, smtpFactory });
  return { input, output, lines, closed };
}

function answer(lines, id) {
  const found = lines.find((line) => line.id === id);
  assert.ok(found, `no reply for id ${id}`);
  return found;
}

async function waitFor(lines, count, label = "replies") {
  const deadline = Date.now() + 3000;
  while (lines.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(lines.length >= count, `timed out waiting for ${count} ${label}, got ${lines.length}`);
}

async function run(handle, messages, count) {
  for (const message of messages) handle.input.write(JSON.stringify(message) + "\n");
  await waitFor(handle.lines, count);
  handle.input.end();
  await handle.closed;
  return handle.lines;
}

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } };
const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

test("initialize logs in and announces the server", async () => {
  const imap = fakeImap({ connectError: null });
  const handle = connect({ env: { GMAIL_ADDRESS: "me@example.com", GMAIL_APP_PASSWORD: "secret" }, imap });
  const lines = await run(handle, [initialize], 1);
  assert.equal(answer(lines, 1).id, 1);
  assert.equal(answer(lines, 1).result.protocolVersion, "2025-03-26");
  assert.equal(answer(lines, 1).result.serverInfo.name, "ravnir-gmail");
  assert.ok(imap.calls.some((row) => row[0] === "connect"));
});

test("initialize without credentials reports the required message", async () => {
  const handle = connect({ env: {} });
  const lines = await run(handle, [initialize], 1);
  assert.equal(answer(lines, 1).error.message, "GMAIL_ADDRESS and GMAIL_APP_PASSWORD are required.");
});

test("initialize reports a rejected login without leaking the password", async () => {
  const refused = Object.assign(new Error("AUTHENTICATIONFAILED supersecret"), { authenticationFailed: true });
  const imap = fakeImap({ connectError: refused });
  const handle = connect({ env: { GMAIL_ADDRESS: "me@example.com", GMAIL_APP_PASSWORD: "supersecret" }, imap });
  const lines = await run(handle, [initialize], 1);
  assert.equal(
    answer(lines, 1).error.message,
    "Gmail rejected the login. Check the address and the app password (https://myaccount.google.com/apppasswords).",
  );
  assert.equal(JSON.stringify(lines).includes("supersecret"), false);
});

test("initialize tells a network failure apart from a wrong password", async () => {
  const imap = fakeImap({ connectError: Object.assign(new Error("connect ECONNREFUSED supersecret"), { code: "ECONNREFUSED" }) });
  const handle = connect({ env: { GMAIL_ADDRESS: "me@example.com", GMAIL_APP_PASSWORD: "supersecret" }, imap });
  const lines = await run(handle, [initialize], 1);
  assert.equal(answer(lines, 1).error.message, "Could not reach Gmail (ECONNREFUSED).");
  assert.equal(JSON.stringify(lines).includes("supersecret"), false);
});

test("tools/list carries the tool names and readOnlyHint annotations", async () => {
  const imap = fakeImap();
  const handle = connect({ env: { GMAIL_ADDRESS: "me@example.com", GMAIL_APP_PASSWORD: "secret" }, imap });
  const lines = await run(handle, [initialize, { jsonrpc: "2.0", id: 2, method: "tools/list" }], 2);
  const tools = answer(lines, 2).result.tools;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["search_email", "read_email", "read_thread", "list_labels", "create_draft", "send_email", "modify_labels"],
  );
  const readOnly = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations.readOnlyHint]));
  assert.equal(readOnly.search_email, true);
  assert.equal(readOnly.read_email, true);
  assert.equal(readOnly.read_thread, true);
  assert.equal(readOnly.list_labels, true);
  assert.equal(readOnly.create_draft, false);
  assert.equal(readOnly.send_email, false);
  assert.equal(readOnly.modify_labels, false);
});

test("search_email searches gmraw on the localized All folder, newest first", async () => {
  const store = [
    message({ uid: 1, subject: "Uno" }),
    message({ uid: 2, subject: "Dos" }),
    message({ uid: 3, subject: "Tres", flags: new Set(["\\Seen"]) }),
  ];
  const imap = fakeImap({ store, searchResult: () => [1, 2, 3] });
  const handle = connect({ env: { GMAIL_ADDRESS: "me@example.com", GMAIL_APP_PASSWORD: "secret" }, imap });
  const lines = await run(handle, [initialize, call(2, "search_email", { query: "from:bank newer_than:7d", limit: 2 })], 2);
  const text = answer(lines, 2).result.content[0].text;
  const search = imap.calls.find((row) => row[0] === "search");
  assert.equal(search[1], ALL);
  assert.deepEqual(search[2], { gmraw: "from:bank newer_than:7d" });
  assert.deepEqual(search[3], { uid: true });
  assert.equal(answer(lines, 2).result.isError, false);
  assert.ok(text.indexOf("subject: Tres") < text.indexOf("subject: Dos"));
  assert.equal(text.includes("subject: Uno"), false);
  assert.match(text, /unread: no/);
  assert.match(text, /unread: yes/);
});

test("read_email returns parsed text, labels and attachment names, cutting long bodies", async () => {
  const longBody = "x".repeat(25_000);
  const store = [message({ uid: 7, subject: "Largo", source: rawMessage({ subject: "Largo", body: longBody }) })];
  const imap = fakeImap({ store });
  const handle = connect({ env: { GMAIL_ADDRESS: "me@example.com", GMAIL_APP_PASSWORD: "secret" }, imap });
  const lines = await run(handle, [initialize, call(2, "read_email", { id: "7" })], 2);
  const text = answer(lines, 2).result.content[0].text;
  assert.match(text, /subject: Largo/);
  assert.match(text, /messageId: <abc@example.com>/);
  assert.match(text, /labels: \\Inbox/);
  assert.match(text, /\[cut\]/);
  assert.match(text, /x{100}/);
  assert.ok(text.length < longBody.length);
});

test("create_draft appends to the localized Drafts folder with reply headers", async () => {
  const store = [message({ uid: 9, source: rawMessage({ messageId: "orig@example.com", references: "<root@example.com>", subject: "Presupuesto" }) })];
  const imap = fakeImap({ store, searchResult: () => [9] });
  const handle = connect({ env: { GMAIL_ADDRESS: "me@example.com", GMAIL_APP_PASSWORD: "secret" }, imap });
  const lines = await run(handle, [initialize, call(2, "create_draft", { to: "ana@example.com", subject: "Presupuesto", body: "Gracias", replyToId: "9" })], 2);
  assert.equal(answer(lines, 2).result.isError, false);
  assert.equal(imap.appended.length, 1);
  assert.equal(imap.appended[0].path, DRAFTS);
  assert.deepEqual(imap.appended[0].flags, ["\\Draft"]);
  const raw = imap.appended[0].content.toString();
  assert.match(raw, /In-Reply-To: <orig@example\.com>/);
  assert.match(raw, /References: <root@example\.com> <orig@example\.com>/);
  assert.match(raw, /Subject: Re: Presupuesto/);
});

test("send_email sends through SMTP with In-Reply-To and References", async () => {
  const store = [message({ uid: 9, source: rawMessage({ messageId: "orig@example.com", references: "<root@example.com>", subject: "Hola" }) })];
  const imap = fakeImap({ store });
  const smtp = fakeSmtp();
  const handle = connect({ env: { GMAIL_ADDRESS: "me@example.com", GMAIL_APP_PASSWORD: "secret" }, imap, smtp });
  const lines = await run(handle, [initialize, call(2, "send_email", { to: "ana@example.com", subject: "Re: Hola", body: "Vale", replyToId: "9" })], 2);
  assert.equal(answer(lines, 2).result.isError, false);
  assert.equal(smtp.sent.length, 1);
  assert.equal(smtp.sent[0].inReplyTo, "<orig@example.com>");
  assert.deepEqual(smtp.sent[0].references, ["<root@example.com>", "<orig@example.com>"]);
  assert.equal(smtp.sent[0].subject, "Re: Hola");
  assert.match(answer(lines, 2).result.content[0].text, /messageId: <sent@example\.com>/);
});

test("modify_labels archive removes the localized Inbox label and adds labels", async () => {
  const store = [message({ uid: 4 })];
  const imap = fakeImap({ store, folderList: [
    { path: INBOX, specialUse: "\\Inbox" },
    { path: ALL, specialUse: "\\All" },
    { path: DRAFTS, specialUse: "\\Drafts" },
  ] });
  const handle = connect({ env: { GMAIL_ADDRESS: "me@example.com", GMAIL_APP_PASSWORD: "secret" }, imap });
  const lines = await run(handle, [initialize, call(2, "modify_labels", { id: "4", add: ["Trabajo"], archive: true, markRead: true })], 2);
  assert.equal(answer(lines, 2).result.isError, false);
  assert.deepEqual(imap.flagAdds[0], { range: "4", flags: ["Trabajo"], options: { uid: true, useLabels: true } });
  assert.deepEqual(imap.flagRemoves[0], { range: "4", flags: [INBOX], options: { uid: true, useLabels: true } });
  assert.deepEqual(imap.flagAdds[1], { range: "4", flags: ["\\Seen"], options: { uid: true } });
});

test("a bad id is a tool error, never a crash", async () => {
  const imap = fakeImap();
  const handle = connect({ env: { GMAIL_ADDRESS: "me@example.com", GMAIL_APP_PASSWORD: "secret" }, imap });
  const lines = await run(handle, [initialize, call(2, "read_email", { id: "1 OR 2" })], 2);
  assert.equal(answer(lines, 2).result.isError, true);
  assert.match(answer(lines, 2).result.content[0].text, /numeric message id/);
});

test("list_labels prints folder paths with their special use", async () => {
  const imap = fakeImap();
  const handle = connect({ env: { GMAIL_ADDRESS: "me@example.com", GMAIL_APP_PASSWORD: "secret" }, imap });
  const lines = await run(handle, [initialize, call(2, "list_labels", {})], 2);
  const text = answer(lines, 2).result.content[0].text;
  assert.match(text, new RegExp(`${ALL.replace(/[[\]]/g, "\\$&")} \\(\\\\All\\)`));
  assert.match(text, /INBOX \(\\Inbox\)/);
});

test("Gmail closing the session is not a crash: the next call opens a new one", async () => {
  const live = () => Object.assign(new EventEmitter(), fakeImap({ store: [message({ uid: 7, subject: "Acme" })], searchResult: () => [7] }));
  const first = live();
  const second = live();
  const handle = connect({ env: { GMAIL_ADDRESS: "me@example.com", GMAIL_APP_PASSWORD: "secret" }, imaps: [first, second] });
  handle.input.write(JSON.stringify(initialize) + "\n");
  handle.input.write(JSON.stringify(call(2, "search_email", { query: "acme" })) + "\n");
  await waitFor(handle.lines, 2);
  // What imapflow does when Gmail drops an idle connection. With no listener this throws and ends the server.
  first.usable = false;
  first.emit("error", Object.assign(new Error("Socket timeout"), { code: "ETIMEOUT" }));
  first.emit("close");
  const lines = await run(handle, [call(3, "search_email", { query: "acme" })], 3);
  assert.equal(answer(lines, 3).result.isError, false);
  assert.match(answer(lines, 3).result.content[0].text, /subject: Acme/);
  assert.ok(second.calls.some((row) => row[0] === "connect"));
});
