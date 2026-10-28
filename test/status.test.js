import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StatusFeeds } from "../server/status/index.js";
import { Vault } from "../server/vault/index.js";

const NOW = Date.parse("2026-10-23T11:00:00Z");
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), `ravnir-status-${prefix}-`));

test("StatusFeeds keeps old figures with a warning and explains a first failure", async () => {
  const set = new Map();
  const vault = { setLive: (note, text) => set.set(note, text) };
  let time = NOW;
  let outcome = { ok: true, text: "Live data from demo (read-only), refreshed X:\n- followers: 25." };
  const feeds = new StatusFeeds({
    vault,
    feeds: [{ note: "Projects/Demo.md", type: "demo" }],
    now: () => time,
    collectors: { demo: () => outcome },
  });

  outcome = { ok: false, error: "database is locked" };
  await feeds.refresh();
  assert.equal(set.get("Projects/Demo.md"), "Live data from demo unavailable (2026-10-23 11:00 UTC): database is locked. Do not quote figures from memory.");
  assert.equal(feeds.status()[0].ok, false);

  outcome = { ok: true, text: "Live data from demo (read-only), refreshed X:\n- followers: 25." };
  await feeds.refresh("Projects/Demo.md");
  assert.equal(set.get("Projects/Demo.md"), outcome.text);
  assert.equal(feeds.status()[0].ok, true);

  time = NOW + 3600000;
  outcome = { ok: false, error: "no such table: account_stats" };
  await feeds.refresh();
  assert.equal(
    set.get("Projects/Demo.md"),
    `${"Live data from demo (read-only), refreshed X:\n- followers: 25."}\n- Warning: the last refresh failed at 2026-10-23 12:00 UTC: no such table: account_stats. These figures are from 2026-10-23 11:00 UTC.`,
  );
  assert.equal(StatusFeeds.load(path.join(os.tmpdir(), "does-not-exist.json")).length, 0);
});

test("the vault overlay puts live figures in read and in bot context", async () => {
  const dir = tmp("vault");
  const put = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  put("Rules.md", "# Rules\nNever store secrets in the vault.\n");
  put("Agents/Chief-of-Staff.md", "# Chief of Staff\nRoutes work across the team.\n");
  put("Projects/Demo.md", "# Demo\nTikTok clips account.\n\n## Estado actual\nOLD-FOLLOWERS-1234 from last month.\n");
  const vault = new Vault({ dir, watch: false, pullMs: 0 });
  await vault.open();
  try {
    const before = vault.read("Demo");
    const live = "Live data from demo (read-only), refreshed 2026-10-23 11:00 UTC:\n- Followers: 25 (data for 2026-10-22).";
    vault.setLive("Demo", live);
    vault.setLive("Projects/Unknown.md", "ignored");
    assert.equal(vault.live("Projects/Unknown.md"), "");

    const after = vault.read("Demo");
    assert.ok(after.body.endsWith(`## Current status (live, from Ravnir)\n${live}\n`));
    assert.notEqual(after.hash, before.hash);

    const own = await vault.contextForBot({ name: "Demo" }, "");
    assert.match(own.text, /Followers: 25/);
    assert.doesNotMatch(own.text, /OLD-FOLLOWERS-1234/);

    const other = await vault.contextForBot({ name: "Chief of Staff" }, "¿Cómo va la cuenta de Demo?");
    assert.match(other.text, /Relevant notes[\s\S]*Projects\/Demo\.md[\s\S]*\n {2}- Followers: 25/);

    const hashOf = (ctx) => ctx.sources.find((s) => s.path === "Projects/Demo.md")?.hash;
    assert.equal(hashOf(own), after.hash);
    assert.equal(hashOf(other), hashOf(own));

    vault.clearLive("Demo");
    assert.equal(vault.read("Demo").hash, before.hash);
  } finally {
    vault.close();
  }
});

test("collectors load from a local folder, constructor collectors win, unknown kinds stay unavailable", async () => {
  const dir = tmp("local");
  fs.writeFileSync(path.join(dir, "alpha.js"), 'export const kind = "alpha";\nexport const collect = () => ({ ok: true, text: "from alpha module" });\n');
  fs.writeFileSync(path.join(dir, "beta.js"), 'export const kind = "beta";\nexport const collect = () => ({ ok: true, text: "beta module" });\n');
  fs.writeFileSync(path.join(dir, "broken.js"), "this is not javascript (");
  fs.writeFileSync(path.join(dir, "nokind.js"), "export const collect = () => ({ ok: true, text: 'x' });\n");
  fs.writeFileSync(path.join(dir, "alpha.test.js"), "throw new Error('tests are never loaded');\n");
  const set = new Map();
  const vault = { setLive: (note, text) => set.set(note, text) };
  const feeds = new StatusFeeds({
    vault,
    feeds: [
      { note: "A.md", type: "alpha" },
      { note: "B.md", type: "beta" },
      { note: "C.md", type: "gamma" },
    ],
    now: () => NOW,
    localDir: dir,
    collectors: { beta: () => ({ ok: true, text: "from constructor" }) },
  });
  await feeds.refresh();
  assert.equal(set.get("A.md"), "from alpha module");
  assert.equal(set.get("B.md"), "from constructor");
  assert.match(set.get("C.md"), /unavailable .*unknown feed type gamma\. Do not quote figures from memory\./);
  assert.deepEqual(feeds.status().map((s) => s.ok), [true, true, false]);

  const missing = new StatusFeeds({ vault, feeds: [{ note: "D.md", type: "alpha" }], now: () => NOW, localDir: path.join(dir, "nope") });
  await missing.refresh();
  assert.match(set.get("D.md"), /unknown feed type alpha/);
});
