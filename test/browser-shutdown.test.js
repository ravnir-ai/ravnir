import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BrowserManager } from "../server/browser.js";
import { browserProfilePath } from "../server/state.js";

// On 2026-10-28 a page that asked for an agent's screen started its browser while the test server
// was closing; closeAll closed only the browsers already open, and the late one kept the process
// alive until CI's three-minute timeout.

test("a browser still starting when the server closes is closed too, not left running", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-browser-shutdown-"));
  const bot = { id: "shutdown-bot", name: "Late", vault: [] };
  const manager = new BrowserManager({ home });
  if (!manager.status(bot).available) return;
  const starting = manager.ensure(bot);
  await manager.closeAll();
  await assert.rejects(starting, /shutting down/);
  const profile = browserProfilePath(home, bot);
  const left = execFileSync("ps", ["-axo", "command="], { encoding: "utf8" }).split("\n").filter((line) => line.includes(profile));
  assert.deepEqual(left, []);
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});
