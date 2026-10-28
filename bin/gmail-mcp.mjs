#!/usr/bin/env node
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import { simpleParser } from "mailparser";

const REQUIRED_MESSAGE = "GMAIL_ADDRESS and GMAIL_APP_PASSWORD are required.";
const LOGIN_MESSAGE =
  "Gmail rejected the login. Check the address and the app password (https://myaccount.google.com/apppasswords).";
const TIMEOUT_MESSAGE = "Gmail did not answer in time.";
const TIMEOUT_MS = 30_000;
const IDLE_MS = 5 * 60_000;
const BODY_LIMIT = 20_000;
const THREAD_BODY_LIMIT = 4_000;
const MAX_BODY_INPUT = 100_000;
const DEFAULT_SEARCH_LIMIT = 15;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_THREAD_LIMIT = 10;
const MAX_THREAD_LIMIT = 25;

class InputError extends Error {}

const toolDefinitions = () => [
  {
    name: "search_email",
    description: "Search Gmail with Gmail search syntax and list the newest matching messages.",
    readOnlyHint: true,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail search syntax, for example from:bank newer_than:7d is:unread" },
        limit: { type: "number", description: "How many messages to return, default 15, max 50" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_email",
    description: "Read one email by id, with headers, labels, attachment names and its plain text body.",
    readOnlyHint: true,
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Message id from search_email" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "read_thread",
    description: "Read every message in a Gmail thread, oldest first, with short bodies.",
    readOnlyHint: true,
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Thread id from search_email or read_email" },
        limit: { type: "number", description: "How many messages to return, default 10, max 25" },
      },
      required: ["threadId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_labels",
    description: "List the Gmail folders and labels with their special use flags.",
    readOnlyHint: true,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_draft",
    description: "Save a draft, optionally as a reply to an existing message.",
    readOnlyHint: false,
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient address" },
        subject: { type: "string", description: "Subject line" },
        body: { type: "string", description: "Plain text body" },
        cc: { type: "string", description: "Optional cc address" },
        replyToId: { type: "string", description: "Optional message id to reply to" },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "send_email",
    description: "Send an email through Gmail, optionally as a reply to an existing message.",
    readOnlyHint: false,
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient address" },
        subject: { type: "string", description: "Subject line" },
        body: { type: "string", description: "Plain text body" },
        cc: { type: "string", description: "Optional cc address" },
        replyToId: { type: "string", description: "Optional message id to reply to" },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "modify_labels",
    description: "Add or remove labels, mark a message read or unread, or archive it.",
    readOnlyHint: false,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Message id" },
        add: { type: "array", items: { type: "string" }, description: "Labels to add" },
        remove: { type: "array", items: { type: "string" }, description: "Labels to remove" },
        markRead: { type: "boolean", description: "true marks read, false marks unread" },
        archive: { type: "boolean", description: "Remove the Inbox label" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

function withTimeout(promise, ms = TIMEOUT_MS, message = TIMEOUT_MESSAGE) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function requireUid(value, field = "id") {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) throw new InputError(`${field} must be a numeric message id.`);
  return text;
}

function requireText(value, field, max) {
  if (typeof value !== "string" || !value.trim()) throw new InputError(`${field} is required.`);
  if (max && value.length > max) throw new InputError(`${field} is longer than ${max} characters.`);
  return value;
}

function optionalText(value, field, max) {
  if (value === undefined || value === null || String(value).trim() === "") return "";
  if (typeof value !== "string") throw new InputError(`${field} must be text.`);
  if (max && value.length > max) throw new InputError(`${field} is longer than ${max} characters.`);
  return value;
}

function stringList(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new InputError(`${field} must be a list of label names.`);
  }
  return value.map((item) => item.trim());
}

function clampLimit(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.min(Math.floor(number), max);
}

function hasFlag(flags, flag) {
  if (!flags) return false;
  if (flags instanceof Set) return flags.has(flag);
  if (Array.isArray(flags)) return flags.includes(flag);
  return false;
}

function addressList(list) {
  const items = Array.isArray(list) ? list : list ? [list] : [];
  const text = items
    .map((item) => {
      const address = String(item?.address || "").trim();
      const name = String(item?.name || "").trim();
      if (!address) return name;
      return name ? `${name} <${address}>` : address;
    })
    .filter(Boolean)
    .join(", ");
  return text || "(none)";
}

function isoDate(value) {
  if (!value) return "(unknown)";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "(unknown)" : date.toISOString();
}

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

function cut(text, limit) {
  const value = String(text || "");
  return value.length > limit ? `${value.slice(0, limit)}\n[cut]` : value;
}

function messageBody(parsed, limit) {
  const text = typeof parsed?.text === "string" && parsed.text.trim() ? parsed.text : htmlToText(parsed?.html || "");
  return cut(text, limit);
}

function normalizeMessageId(value) {
  const text = String(value || "").trim().replace(/^</, "").replace(/>$/, "");
  return text ? `<${text}>` : "";
}

function referenceList(value) {
  if (!value) return [];
  const items = Array.isArray(value) ? value : String(value).split(/[\s,]+/);
  return items.map((item) => normalizeMessageId(item)).filter(Boolean);
}

function envelopeLines(meta) {
  const envelope = meta.envelope || {};
  return [
    `id: ${meta.uid}`,
    `threadId: ${meta.threadId ?? ""}`,
    `date: ${isoDate(meta.internalDate)}`,
    `from: ${addressList(envelope.from)}`,
    `to: ${addressList(envelope.to)}`,
    `subject: ${envelope.subject || "(no subject)"}`,
    `labels: ${meta.labels ? [...meta.labels].join(", ") : "(none)"}`,
    `unread: ${hasFlag(meta.flags, "\\Seen") ? "no" : "yes"}`,
  ];
}

function formatMessage(meta) {
  return envelopeLines(meta).join("\n");
}

function formatFullMessage(meta, parsed, limit) {
  const cc = Array.isArray(parsed?.cc) ? parsed.cc : parsed?.cc ? [parsed.cc] : [];
  const attachments = Array.isArray(parsed?.attachments) ? parsed.attachments : [];
  const lines = envelopeLines(meta);
  lines.push(`cc: ${addressList(cc)}`);
  lines.push(`messageId: ${normalizeMessageId(parsed?.messageId) || "(none)"}`);
  lines.push(
    attachments.length
      ? `attachments: ${attachments
          .map((item) => `${item.filename || "(unnamed)"} (${Number(item.size) || 0} bytes)`)
          .join(", ")}`
      : "attachments: (none)",
  );
  lines.push("", messageBody(parsed, limit));
  return lines.join("\n");
}

function sortAscending(uids) {
  return [...uids].sort((a, b) => Number(a) - Number(b));
}

export function createGmailMcp({ input, output, env = process.env, imapFactory, smtpFactory, name = "ravnir-gmail", version = "1.0.0" }) {
  const address = String(env.GMAIL_ADDRESS || "").trim();
  const password = String(env.GMAIL_APP_PASSWORD || "");
  const imapHost = env.GMAIL_IMAP_HOST || "imap.gmail.com";
  const imapPort = Number(env.GMAIL_IMAP_PORT || 993);
  const smtpHost = env.GMAIL_SMTP_HOST || "smtp.gmail.com";
  const smtpPort = Number(env.GMAIL_SMTP_PORT || 465);

  let client = null;
  let folderCache = null;
  let idleTimer = null;
  let closing = null;

  const write = (message) => output.write(JSON.stringify(message) + "\n");
  const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });
  const toolError = (id, error) => {
    let text = String(error?.message || "The tool failed.");
    if (password) text = text.split(password).join("***");
    reply(id, { content: [{ type: "text", text }], isError: true });
  };

  function safeMessage(error) {
    let text = String(error?.message || "The tool failed.");
    if (password) text = text.split(password).join("***");
    return text;
  }

  function clearIdle() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function scheduleIdle() {
    clearIdle();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      void dropClient();
    }, IDLE_MS);
    idleTimer.unref?.();
  }

  async function dropClient() {
    const current = client;
    client = null;
    folderCache = null;
    clearIdle();
    if (!current) return;
    try {
      if (typeof current.logout === "function") await current.logout();
    } catch {
      // The connection is going away on purpose.
    }
    try {
      current.close?.();
    } catch {
      // Already closed.
    }
  }

  async function ensureClient() {
    if (client && client.usable) {
      scheduleIdle();
      return client;
    }
    if (!address || !password) throw new Error(REQUIRED_MESSAGE);
    const transport = imapFactory({
      host: imapHost,
      port: imapPort,
      secure: true,
      auth: { user: address, pass: password },
      logger: false,
    });
    // Gmail closes idle sessions and imapflow reports that as an "error" event. Without a listener
    // Node ends the whole server, so a dead session is only forgotten and the next call reconnects.
    const forget = () => {
      if (client !== transport) return;
      client = null;
      folderCache = null;
      clearIdle();
    };
    transport.on?.("error", forget);
    transport.on?.("close", forget);
    try {
      await withTimeout(transport.connect?.());
    } catch (error) {
      try {
        transport.close?.();
      } catch {
        // Nothing to close.
      }
      if (error?.message === TIMEOUT_MESSAGE) throw error;
      // imapflow marks a refused password; anything else is the network or Gmail itself.
      if (error?.authenticationFailed) throw new Error(LOGIN_MESSAGE);
      throw new Error(`Could not reach Gmail (${String(error?.code || "network error").slice(0, 40)}).`);
    }
    client = transport;
    folderCache = null;
    scheduleIdle();
    return client;
  }

  function dropped(error, current) {
    if (current && current.usable === false) return true;
    const code = String(error?.code || "");
    return ["NoConnection", "ConnectionClosed", "EConnectionClosed", "ENOTCONN", "ECONNRESET", "EPIPE", "ECONNECTION"].includes(code);
  }

  async function withClient(fn) {
    clearIdle();
    let current = await ensureClient();
    clearIdle();
    try {
      return await withTimeout(fn(current));
    } catch (error) {
      // A command that timed out may still hold the session, so the next call starts a fresh one.
      if (error?.message === TIMEOUT_MESSAGE) {
        await dropClient();
        throw error;
      }
      if (!dropped(error, current)) throw error;
      await dropClient();
      current = await ensureClient();
      try {
        return await withTimeout(fn(current));
      } finally {
        scheduleIdle();
      }
    } finally {
      scheduleIdle();
    }
  }

  async function allFolder(imap) {
    return folderFor(imap, "\\All");
  }

  async function folderFor(imap, specialUse) {
    if (!folderCache) {
      const folders = await imap.list();
      folderCache = new Map();
      for (const folder of folders || []) {
        if (folder?.specialUse) folderCache.set(folder.specialUse, folder.path);
      }
    }
    const path = folderCache.get(specialUse);
    if (!path) throw new Error(`Gmail did not report a folder with special use ${specialUse}.`);
    return path;
  }

  async function replyReferences(imap, id) {
    if (!id) return { inReplyTo: "", references: [] };
    const original = await imap.fetchOne(requireUid(id, "replyToId"), { source: true }, { uid: true });
    if (!original?.source) throw new Error(`No message with id ${id}.`);
    const parsed = await simpleParser(original.source);
    const inReplyTo = normalizeMessageId(parsed.messageId);
    const references = [...referenceList(parsed.references), normalizeMessageId(parsed.messageId)].filter(Boolean);
    return { inReplyTo, references };
  }

  async function buildMessage(args) {
    const to = requireText(args.to, "to");
    const subject = typeof args.subject === "string" ? args.subject : requireText(args.subject, "subject");
    const body = requireText(args.body, "body", MAX_BODY_INPUT);
    const cc = optionalText(args.cc, "cc");
    const replyToId = args.replyToId === undefined || args.replyToId === null || args.replyToId === "" ? "" : requireUid(args.replyToId, "replyToId");
    return { to, subject, body, cc, replyToId };
  }

  function replySubject(subject, inReplyTo) {
    if (!inReplyTo) return subject;
    return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
  }

  const handlers = {
    async search_email(args) {
      const query = requireText(args.query, "query");
      const limit = clampLimit(args.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
      return withClient(async (imap) => {
        const path = await allFolder(imap);
        await imap.mailboxOpen(path);
        const uids = sortAscending((await imap.search({ gmraw: query }, { uid: true })) || []);
        if (!uids.length) return "No messages match that search.";
        const picked = uids.slice(-limit);
        const messages = await imap.fetchAll(
          picked,
          { envelope: true, flags: true, labels: true, threadId: true, internalDate: true },
          { uid: true },
        );
        const byId = new Map((messages || []).map((message) => [String(message.uid), message]));
        const blocks = [];
        for (const uid of [...picked].sort((a, b) => Number(b) - Number(a))) {
          const meta = byId.get(String(uid));
          if (meta) blocks.push(formatMessage(meta));
        }
        if (!blocks.length) return "No messages match that search.";
        return blocks.join("\n\n");
      });
    },

    async read_email(args) {
      const id = requireUid(args.id);
      return withClient(async (imap) => {
        const path = await allFolder(imap);
        await imap.mailboxOpen(path);
        const meta = await imap.fetchOne(
          id,
          { envelope: true, flags: true, labels: true, threadId: true, internalDate: true, source: true },
          { uid: true },
        );
        if (!meta) throw new Error(`No message with id ${id}.`);
        const parsed = await simpleParser(meta.source);
        return formatFullMessage(meta, parsed, BODY_LIMIT);
      });
    },

    async read_thread(args) {
      const threadId = requireUid(args.threadId, "threadId");
      const limit = clampLimit(args.limit, DEFAULT_THREAD_LIMIT, MAX_THREAD_LIMIT);
      return withClient(async (imap) => {
        const path = await allFolder(imap);
        await imap.mailboxOpen(path);
        const uids = sortAscending((await imap.search({ threadId }, { uid: true })) || []);
        if (!uids.length) return "No messages in that thread.";
        const picked = uids.slice(-limit);
        const blocks = [];
        for (const uid of picked) {
          const meta = await imap.fetchOne(
            uid,
            { envelope: true, flags: true, labels: true, threadId: true, internalDate: true, source: true },
            { uid: true },
          );
          if (!meta) continue;
          const parsed = await simpleParser(meta.source);
          blocks.push(formatFullMessage(meta, parsed, THREAD_BODY_LIMIT));
        }
        return blocks.length ? blocks.join("\n\n---\n\n") : "No messages in that thread.";
      });
    },

    async list_labels() {
      return withClient(async (imap) => {
        const folders = (await imap.list()) || [];
        if (!folders.length) return "Gmail reported no folders.";
        return folders
          .map((folder) => `${folder.path}${folder.specialUse ? ` (${folder.specialUse})` : ""}`)
          .join("\n");
      });
    },

    async create_draft(args) {
      const mail = await buildMessage(args);
      return withClient(async (imap) => {
        const all = await allFolder(imap);
        await imap.mailboxOpen(all);
        const { inReplyTo, references } = await replyReferences(imap, mail.replyToId);
        const options = { from: address, to: mail.to, subject: replySubject(mail.subject, inReplyTo), text: mail.body };
        if (mail.cc) options.cc = mail.cc;
        if (inReplyTo) {
          options.inReplyTo = inReplyTo;
          options.references = references;
        }
        const raw = await new MailComposer(options).compile().build();
        const drafts = await folderFor(imap, "\\Drafts");
        await imap.append(drafts, raw, ["\\Draft"]);
        return `Draft saved\n to: ${mail.to}\n subject: ${options.subject}`;
      });
    },

    async send_email(args) {
      const mail = await buildMessage(args);
      return withClient(async (imap) => {
        let inReplyTo = "";
        let references = [];
        if (mail.replyToId) {
          const all = await allFolder(imap);
          await imap.mailboxOpen(all);
          ({ inReplyTo, references } = await replyReferences(imap, mail.replyToId));
        }
        const subject = replySubject(mail.subject, inReplyTo);
        const transport = smtpFactory({
          host: smtpHost,
          port: smtpPort,
          secure: smtpPort === 465,
          auth: { user: address, pass: password },
        });
        const options = { from: address, to: mail.to, subject, text: mail.body };
        if (mail.cc) options.cc = mail.cc;
        if (inReplyTo) {
          options.inReplyTo = inReplyTo;
          options.references = references;
        }
        const info = await withTimeout(transport.sendMail(options));
        return `Sent\n to: ${mail.to}\n subject: ${subject}\n messageId: ${info?.messageId || "(unknown)"}`;
      });
    },

    async modify_labels(args) {
      const id = requireUid(args.id);
      const add = stringList(args.add, "add");
      const remove = stringList(args.remove, "remove");
      const markRead = args.markRead === undefined ? undefined : Boolean(args.markRead);
      const archive = args.archive === true;
      return withClient(async (imap) => {
        const all = await allFolder(imap);
        await imap.mailboxOpen(all);
        const changes = [];
        if (archive) {
          const inbox = folderCache?.get("\\Inbox") || "INBOX";
          if (!remove.includes(inbox)) remove.push(inbox);
        }
        if (add.length) {
          await imap.messageFlagsAdd(id, add, { uid: true, useLabels: true });
          changes.push(`added ${add.join(", ")}`);
        }
        if (remove.length) {
          await imap.messageFlagsRemove(id, remove, { uid: true, useLabels: true });
          changes.push(`removed ${remove.join(", ")}`);
        }
        if (markRead === true) {
          await imap.messageFlagsAdd(id, ["\\Seen"], { uid: true });
          changes.push("marked read");
        } else if (markRead === false) {
          await imap.messageFlagsRemove(id, ["\\Seen"], { uid: true });
          changes.push("marked unread");
        }
        return changes.length ? `Changed: ${changes.join(", ")}.` : "Nothing to change.";
      });
    },
  };

  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  rl.on("line", async (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail(null, -32700, "Parse error");
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      fail(null, -32601, "Method not found");
      return;
    }
    const { id, method, params } = message;
    if (id === undefined) return;
    if (method === "initialize") {
      try {
        await ensureClient();
      } catch (error) {
        fail(id, -32000, safeMessage(error));
        return;
      }
      reply(id, {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name, version },
      });
      return;
    }
    if (method === "ping") {
      reply(id, {});
      return;
    }
    if (method === "tools/list") {
      reply(id, {
        tools: toolDefinitions().map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: { readOnlyHint: tool.readOnlyHint },
        })),
      });
      return;
    }
    if (method === "tools/call") {
      const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
      const handler = handlers[String(params?.name || "")];
      if (!handler) {
        toolError(id, new Error(`Unknown tool ${String(params?.name || "")}.`));
        return;
      }
      try {
        const text = await handler(args);
        reply(id, { content: [{ type: "text", text }], isError: false });
      } catch (error) {
        toolError(id, error);
      }
      return;
    }
    fail(id, -32601, "Method not found");
  });

  const closed = new Promise((resolve) => rl.on("close", resolve));
  return {
    closed: closed.then(async () => {
      if (closing) return closing;
      closing = dropClient();
      await closing;
    }),
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { ImapFlow } = await import("imapflow");
  const { closed } = createGmailMcp({
    input: process.stdin,
    output: process.stdout,
    env: process.env,
    imapFactory: (options) => new ImapFlow(options),
    smtpFactory: (options) => nodemailer.createTransport(options),
  });
  await closed;
  process.exit(0);
}
