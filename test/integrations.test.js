import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OnePassword } from "../server/onepassword.js";

test("1Password reads logins through the CLI without exposing the password in status or lists", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-op-"));
  const bin = path.join(dir, "op");
  fs.writeFileSync(bin, `#!/bin/sh
case "$1 $2" in
  "--version ") echo "2.34.0" ;;
  "whoami --format=json") echo '{"url":"my.1password.com"}' ;;
  "item list") echo '[{"id":"item-1","title":"Example","vault":{"id":"vault-1","name":"Private"},"urls":[{"href":"https://example.com"}],"additional_information":"user@example.com"}]' ;;
  "item get") case "$*" in *"--vault vault-1"*) ;; *) echo "[ERROR] a vault query must be provided when this command is called by a service account" >&2; exit 1 ;; esac
    echo '{"urls":[{"href":"https://example.com"}],"fields":[{"purpose":"USERNAME","value":"user@example.com"},{"purpose":"PASSWORD","value":"hunter2"}]}' ;;
  *) exit 1 ;;
esac
`);
  fs.chmodSync(bin, 0o755);
  const before = process.env.RAVNIR_OP_BIN;
  process.env.RAVNIR_OP_BIN = bin;
  try {
    const op = new OnePassword();
    const status = await op.status({ fresh: true });
    assert.equal(status.installed, true);
    assert.equal(status.signedIn, true);
    assert.equal(status.version, "2.34.0");
    const items = await op.listLogins("example");
    assert.equal(items.length, 1);
    assert.equal(items[0].username, "user@example.com");
    assert.equal(JSON.stringify(items).includes("hunter2"), false);
    const login = await op.readLogin("item-1");
    assert.equal(login.username, "user@example.com");
    assert.equal(login.password, "hunter2");
    assert.equal(login.site, "https://example.com");
  } finally {
    if (before === undefined) delete process.env.RAVNIR_OP_BIN;
    else process.env.RAVNIR_OP_BIN = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a signed-out 1Password CLI gives a plain 409, not a server error with the CLI's output", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-op-out-"));
  const bin = path.join(dir, "op");
  fs.writeFileSync(bin, `#!/bin/sh
case "$1 $2" in
  "--version ") echo "2.34.0" ;;
  *) echo "[ERROR] 2026/10/25 20:00:00 account is not signed in" >&2; exit 1 ;;
esac
`);
  fs.chmodSync(bin, 0o755);
  const before = process.env.RAVNIR_OP_BIN;
  process.env.RAVNIR_OP_BIN = bin;
  try {
    const op = new OnePassword();
    op.clearCache();
    assert.equal((await op.status({ fresh: true })).signedIn, false);
    await assert.rejects(op.listLogins(""), (error) => error.status === 409 && /not signed in/.test(error.message) && !/\[ERROR\]/.test(error.message));
  } finally {
    if (before === undefined) delete process.env.RAVNIR_OP_BIN;
    else process.env.RAVNIR_OP_BIN = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
