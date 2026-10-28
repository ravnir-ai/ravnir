#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const FILE = process.env.TICKETS_FILE;
if (!FILE) {
  process.stderr.write("TICKETS_FILE is required\n");
  process.exit(1);
}

const INITIAL = {
  tickets: [
    { id: "T-41", title: "Printer on floor 2 is offline", status: "open", notes: [] },
    { id: "T-42", title: "Refund for order N-1043", status: "open", notes: [] },
    { id: "T-43", title: "New laptop for Sam", status: "open", notes: [] },
  ],
};

const TOOLS = [
  {
    name: "list_tickets",
    description: "List tickets, optionally filtered by status.",
    inputSchema: {
      type: "object",
      properties: { status: { type: "string", enum: ["open", "closed"] } },
      additionalProperties: false,
    },
  },
  {
    name: "get_ticket",
    description: "Read one ticket as JSON.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "close_ticket",
    description: "Close a ticket with a note.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, note: { type: "string" } },
      required: ["id", "note"],
      additionalProperties: false,
    },
  },
  {
    name: "add_note",
    description: "Add a note to a ticket.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, note: { type: "string" } },
      required: ["id", "note"],
      additionalProperties: false,
    },
  },
  {
    name: "create_ticket",
    description: "Create a new open ticket.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, body: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    },
  },
];

function readState() {
  let raw;
  try {
    raw = readFileSync(FILE, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    writeState(INITIAL);
    return structuredClone(INITIAL);
  }
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.tickets)) throw new Error("Invalid tickets file");
  return parsed;
}

function writeState(state) {
  writeFileSync(FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function text(value) {
  return { content: [{ type: "text", text: value }] };
}

function fail(value) {
  return { content: [{ type: "text", text: value }], isError: true };
}

function findTicket(state, id) {
  return state.tickets.find((ticket) => ticket.id === id);
}

function nextId(state) {
  let max = 0;
  for (const ticket of state.tickets) {
    const match = /^T-(\d+)$/.exec(ticket.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `T-${max + 1}`;
}

function callTool(name, args) {
  const state = readState();

  if (name === "list_tickets") {
    const status = args.status;
    const tickets = state.tickets.filter((ticket) => !status || ticket.status === status);
    if (tickets.length === 0) return text("");
    return text(
      tickets.map((ticket) => `${ticket.id} [${ticket.status}] ${ticket.title}`).join("\n"),
    );
  }

  if (name === "get_ticket") {
    if (!args.id) return fail("Missing id.");
    const ticket = findTicket(state, args.id);
    if (!ticket) return fail(`No ticket ${args.id}.`);
    return text(JSON.stringify(ticket));
  }

  if (name === "close_ticket") {
    if (!args.id || args.note === undefined) return fail("Missing id or note.");
    const ticket = findTicket(state, args.id);
    if (!ticket) return fail(`No ticket ${args.id}.`);
    ticket.status = "closed";
    ticket.notes.push(String(args.note));
    writeState(state);
    return text(`Closed ${ticket.id}.`);
  }

  if (name === "add_note") {
    if (!args.id || args.note === undefined) return fail("Missing id or note.");
    const ticket = findTicket(state, args.id);
    if (!ticket) return fail(`No ticket ${args.id}.`);
    ticket.notes.push(String(args.note));
    writeState(state);
    return text(`Noted on ${ticket.id}.`);
  }

  if (name === "create_ticket") {
    if (!args.title) return fail("Missing title.");
    const ticket = { id: nextId(state), title: String(args.title), status: "open", notes: [] };
    if (args.body !== undefined && args.body !== "") ticket.notes.push(String(args.body));
    state.tickets.push(ticket);
    writeState(state);
    return text(`Created ${ticket.id}.`);
  }

  return null;
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: message.params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "Northwind tickets", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "tools/list") {
    respond(message.id, { tools: TOOLS });
    return;
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    try {
      const result = callTool(name, message.params?.arguments || {});
      if (result === null) {
        respondError(message.id, -32602, `Unknown tool ${name}`);
        return;
      }
      respond(message.id, result);
    } catch (error) {
      respond(message.id, fail(error.message));
    }
    return;
  }
  respondError(message.id, -32601, `Unknown method ${message.method}`);
}

let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(line);
    newline = buffer.indexOf("\n");
  }
});
