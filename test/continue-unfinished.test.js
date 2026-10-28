import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/index.js";
import { soundsUnfinished } from "../server/turn.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.RAVNIR_AI_MEMORY = "off";
process.env.RAVNIR_QUICK = "off";

test("a reply that only announces more work counts as unfinished", () => {
  assert.equal(soundsUnfinished("ClipDemo ya está dentro. Hay 9 campañas activas. Voy a abrir las que pueden encajar con negocios y con mentalidad."), true);
  assert.equal(soundsUnfinished("Rewards Demo ya está dentro. Estoy descartando las que exigen el nombre del creador. Sigo con las que pueden aceptar cuentas de nicho."), true);
  assert.equal(soundsUnfinished("Logged in. Next I'll open the campaign list."), true);
  assert.equal(soundsUnfinished("Hecho. Encajan 3 campañas: A, B y C."), false);
  assert.equal(soundsUnfinished("¿Quieres que siga con Rewards Demo?"), false);
  assert.equal(soundsUnfinished(""), false);
});

// A stand-in OpenCode: the first prompt ends on a progress line after a tool call, the next one finishes.
function startOpenCode() {
  const messages = [];
  const prompts = [];
  const user = (text) => ({ info: { role: "user", time: { created: Date.now() } }, parts: [{ type: "text", text }] });
  const assistant = (parts) => ({ info: { role: "assistant", time: { created: Date.now(), completed: Date.now() + 1 } }, parts });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (body, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(status === 204 ? "" : JSON.stringify(body));
    };
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (url.pathname === "/global/health") return send({ healthy: true });
      if (url.pathname === "/provider") return send({ all: [] });
      if (url.pathname === "/session/status") return send({});
      if (url.pathname === "/permission") return send([]);
      if (url.pathname.endsWith("/diff")) return send([]);
      if (req.method === "POST" && url.pathname === "/session") return send({ id: "ses1" });
      if (url.pathname === "/session/ses1/message" && req.method === "GET") return send(messages);
      if (url.pathname === "/session/ses1/prompt_async" || (url.pathname === "/session/ses1/message" && req.method === "POST")) {
        const body = JSON.parse(raw || "{}");
        const text = (body.parts || []).map((part) => part.text || "").join("\n");
        prompts.push(text);
        messages.push(user(text));
        const tool = { type: "tool", callID: `t${prompts.length}`, tool: "browser_read", state: { status: "completed", input: {}, output: "page" } };
        messages.push(assistant(prompts.length === 1
          ? [tool, { type: "text", text: "Ya estoy dentro. Sigo con las campañas que encajan." }]
          : [tool, { type: "text", text: "Hecho. Encajan 2 campañas: Clips Hablando y Mario Vincere." }]));
        return url.pathname.endsWith("prompt_async") ? send({}, 204) : send(messages.at(-1));
      }
      send({}, 404);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, prompts, url: `http://127.0.0.1:${server.address().port}` })));
}

test("a turn that stops on a progress line is asked to finish and ends with the result", async () => {
  const opencode = await startOpenCode();
  const app = createApp({ home: fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-continue-")), projectRoot });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const api = async (method, pathname, body) => {
    const response = await fetch(`${base}${pathname}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    assert.equal(response.ok, true, JSON.stringify(data));
    return data;
  };
  try {
    const { bot } = await api("POST", "/api/bots", { name: "Researcher", job: "Research", model: { provider: "opencode", baseUrl: opencode.url, apiKey: "pw", model: "" } });
    const { turnId } = await api("POST", `/api/bots/${bot.id}/messages`, { text: "entra y dime qué campañas encajan" });
    let end;
    for (let i = 0; i < 150 && !end; i += 1) {
      const { events } = await api("GET", `/api/bots/${bot.id}/events?after=0`);
      end = events.find((event) => event.type === "turn.end" && event.turnId === turnId);
      if (!end) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(end, "turn ended");
    assert.equal(opencode.prompts.length, 2);
    assert.match(opencode.prompts[1], /finish the task/);
    assert.match(end.messages.at(-1).content, /Encajan 2 campañas/);
  } finally {
    app.close();
    opencode.server.close();
  }
});
