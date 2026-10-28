import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { clearFlavorCache, runOpenCodeTurn, toolParts } from "../server/providers/opencode.js";

const toolPart = (id, tool, output) => ({
  type: "tool",
  callID: id,
  tool,
  state: { status: "completed", input: {}, output },
});
const assistant = (parts, at) => ({ info: { role: "assistant", time: { created: at, completed: at + 1 } }, parts });
const user = (text) => ({ info: { role: "user" }, parts: [{ type: "text", text }] });

test("toolParts without a boundary still lists every assistant tool call", () => {
  const json = [user("a"), assistant([toolPart("t1", "bash", "x")], 1)];
  assert.deepEqual(toolParts(json).map((tool) => tool.id), ["t1"]);
});

test("a user message OpenCode adds later in the turn does not hide the turn's earlier tool calls", () => {
  const json = [
    user("earlier turn"), assistant([toolPart("old", "bash", "x")], 1),
    user("this turn"), assistant([toolPart("mine", "bash", "y")], 2),
    user("(synthetic: continue)"), assistant([toolPart("mine-2", "bash", "z")], 3),
  ];
  assert.deepEqual(toolParts(json, { afterUsers: 1 }).map((tool) => tool.id), ["mine", "mine-2"]);
  assert.deepEqual(toolParts(json.slice(0, 2), { afterUsers: 1 }), [], "nothing of this turn is listed yet");
});

async function runTurn({ delayMs = 0 } = {}) {
  const messages = [
    user("open example.com"),
    assistant([toolPart("old-browser", "computer_task", "Example Domain"), toolPart("old-desktop", "desktop_task", "clicked")], 10),
  ];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (body, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/global/health") return send({ healthy: true });
    if (url.pathname === "/provider") return send({ all: [] });
    if (url.pathname === "/session/status") return send({});
    if (url.pathname === "/permission") return send([]);
    if (url.pathname.endsWith("/diff")) return send([]);
    if (url.pathname === "/session/ses1/message") return send(messages);
    if (url.pathname === "/session/ses1/prompt_async") {
      req.resume();
      req.on("end", () => {
        // OpenCode may list the new user message only a moment after accepting the prompt.
        setTimeout(() => {
          messages.push(user("now check the weather"));
          messages.push(assistant([toolPart("new-search", "web_search", "sunny"), { type: "text", text: "It is sunny." }], 20));
        }, delayMs);
        send({}, 204);
      });
      return;
    }
    send({}, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    clearFlavorCache();
    const bot = { name: "Lead Engineer", model: { provider: "opencode", baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "pw", model: "" } };
    const events = [];
    const result = await runOpenCodeTurn({
      bot,
      directory: "/ws",
      remote: { id: "ses1", flavor: "classic", directory: "/ws", promptAttached: true },
      title: "t",
      text: "now check the weather",
      systemPrompt: "sys",
      history: "",
      emit: (event) => events.push(event),
      waitForDecision: async () => "reject",
    });
    return { result, tools: [...new Set(events.filter((event) => event.type === "tool").map((event) => event.id))] };
  } finally {
    server.close();
  }
}

test("a new turn emits only its own tool calls, not those of earlier turns in the session", async () => {
  const { result, tools } = await runTurn();
  assert.equal(result.text, "It is sunny.");
  assert.deepEqual(tools, ["new-search"]);
});

test("before the new user message is listed, the previous turn's tool calls are not replayed", async () => {
  const { result, tools } = await runTurn({ delayMs: 1600 });
  assert.equal(result.text, "It is sunny.");
  assert.deepEqual(tools, ["new-search"]);
});
