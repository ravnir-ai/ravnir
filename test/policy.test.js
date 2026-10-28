import assert from "node:assert/strict";
import test from "node:test";
import { describePolicy, matchesPattern, normalizePolicy, openCodePermission, suggestAlwaysRule } from "../server/policy.js";

test("OpenCode's own question tool is denied for every agent, and a refused request does not end the agent silently", () => {
  assert.equal(openCodePermission({}).question, "deny");
  assert.equal(openCodePermission({ shell: "allow" }).question, "deny");
  assert.equal(openCodePermission({}, { ownComputer: true }).question, "deny");
  assert.match(describePolicy(normalizePolicy({})), /do not retry it or a variant; finish what you can without it and say what you could not check/);
});

test("suggestAlwaysRule builds a generalized allow-list rule", () => {
  const cases = [
    ["git status", "git status"],
    ["git status -s", "git status *"],
    ["git log --oneline -5", "git log *"],
    ["ls -la /opt", "ls *"],
    ["ls", "ls"],
    ["npm test", "npm test"],
    ["npm run build", "npm run build"],
    ["npm run build -- --watch", "npm run build *"],
    ["gh pr list --limit 5", "gh pr list *"],
    ["gh pr view 12", "gh pr view *"],
    ["ssh deploy@203.0.113.10 informe", "ssh deploy@203.0.113.10 informe"],
    ["cat a.txt | grep x", ""],
    ["git add -A && git commit -m x", ""],
    ["rm -rf build", "rm -rf build"],
    ["echo hi > f", "echo hi > f"],
    ['git commit -m "x"', 'git commit -m "x"'],
    ["/usr/bin/sudo ls", "/usr/bin/sudo ls"],
    ["  git   status  ", "git status"],
    ["", ""],
  ];
  for (const [command, expected] of cases) {
    assert.equal(suggestAlwaysRule(command), expected, `rule for ${JSON.stringify(command)}`);
  }
});

test("suggestAlwaysRule rules still match the commands they generalize", () => {
  const generalized = [
    ["git status -s", "git status *"],
    ["git log --oneline -5", "git log *"],
    ["ls -la /opt", "ls *"],
    ["npm run build -- --watch", "npm run build *"],
    ["gh pr list --limit 5", "gh pr list *"],
    ["gh pr view 12", "gh pr view *"],
  ];
  for (const [command, expected] of generalized) {
    const rule = suggestAlwaysRule(command);
    assert.equal(rule, expected);
    assert.ok(matchesPattern(rule, command), `${rule} should match ${command}`);
  }
});

test("a chained command can only be allowed once", async () => {
  const { ApprovalCenter } = await import("../server/approvals.js");
  const { guardTool } = await import("../server/policy.js");
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-policy-"));
  const approvals = new ApprovalCenter({ home });
  const bot = { id: "b1", name: "Tester", policy: { shell: "ask", allow: [] } };
  const pending = guardTool("run_command", { command: "git add -A && git commit -m x" }, { bot, approvals });
  const [record] = approvals.pending();
  assert.equal(record.rule, "");
  assert.equal(record.onceOnly, true);
  approvals.decide(record.id, "always");
  await pending;
  assert.deepEqual(bot.policy.allow, []);
  assert.equal(approvals.records.at(-1).decision, "once");
});
