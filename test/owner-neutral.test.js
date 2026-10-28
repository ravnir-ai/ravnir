import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "plugins" ? [] : files(full);
    return /\.(m?js|html|css)$/.test(entry.name) ? [full] : [];
  });
}

// Private terms (the owner's name, hosts, project names) come from export/deny.txt, one per line.
// The list lives outside the code so the test itself never spells them.
const denyFile = path.join(root, "export", "deny.txt");
const terms = fs.existsSync(denyFile)
  ? fs.readFileSync(denyFile, "utf8").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))
  : [];

const escape = (term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("no private term is written into the server or the app", { skip: terms.length ? false : "export/deny.txt is not present" }, () => {
  const pattern = new RegExp(`(?<![\\w])(?:${terms.map(escape).join("|")})(?![\\w])`, "i");
  const hits = ["server", "public", "bin"].flatMap((dir) => files(path.join(root, dir)))
    .filter((file) => pattern.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(root, file));
  assert.deepEqual(hits, []);
});
