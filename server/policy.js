import { expandHome, insideMacRoots, sensitiveMacCommand, sensitiveMacPath } from "./macNode.js";

// Per-bot rules for risky actions, and daily spending caps.
// The server enforces these. The prompt only tells the bot what to expect.

export const POLICY_MODES = ["allow", "ask", "deny"];
// A plugin action that changes something is "ask" (the default) or "allow" (see plugins.js).
const PLUGIN_MODES = ["ask", "allow"];
const MAX_PATTERNS = 40;

export function defaultPolicy() {
  return { shell: "ask", allow: [], files: "ask", logins: "ask", plugins: "ask" };
}

export function normalizePolicy(input) {
  const base = defaultPolicy();
  if (!input || typeof input !== "object") return base;
  return {
    shell: POLICY_MODES.includes(input.shell) ? input.shell : base.shell,
    allow: cleanPatterns(input.allow),
    files: POLICY_MODES.includes(input.files) ? input.files : base.files,
    logins: POLICY_MODES.includes(input.logins) ? input.logins : base.logins,
    plugins: PLUGIN_MODES.includes(input.plugins) ? input.plugins : base.plugins,
  };
}

export function normalizeLimits(input) {
  const money = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value) * 10_000) / 10_000 : 0);
  const count = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : 0);
  return {
    dailyCost: money(input?.dailyCost),
    dailyTokens: count(input?.dailyTokens),
    // Calendar month, server time. Either cap stops new turns once reached.
    monthlyCost: money(input?.monthlyCost),
    monthlyTokens: count(input?.monthlyTokens),
  };
}

// "Always allow" adds a rule. A full list drops its oldest rule instead of ignoring the new one.
export function withAllowRule(policy, rule) {
  const rules = normalizePolicy(policy);
  const text = String(rule || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!text || rules.allow.includes(text)) return rules;
  const allow = [...rules.allow, text];
  while (allow.length > MAX_PATTERNS) allow.shift();
  return normalizePolicy({ ...rules, allow });
}

function cleanPatterns(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const value = String(item || "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (value && !out.includes(value)) out.push(value);
  }
  return out.slice(0, MAX_PATTERNS);
}

// A pattern is a command with * wildcards: "gh pr view *" matches "gh pr view 12".
export function matchesPattern(pattern, command) {
  const text = String(command || "").replace(/\s+/g, " ").trim();
  const source = String(pattern || "").replace(/\s+/g, " ").trim();
  if (!source) return false;
  const regex = new RegExp(`^${source.split("*").map(escapeRegex).join(".*")}$`, "s");
  return regex.test(text);
}

// Chaining or redirection could smuggle a second action past an allowed prefix.
// One trailing redirect to a plain file in the workspace is fine.
const CHAINING = /[;&|`\n<>]|\$\(/;
const WORKSPACE_REDIRECT = /\s*[<>]\s*[\w.-]+\s*$/;

// Reaching another machine always asks, even for a trusted bot, unless that
// exact command is on the allow list.
const REMOTE_PROGRAMS = ["ssh", "scp", "sftp", "rsync", "mosh"];
const REMOTE = new RegExp(`(^|[\\s;&|(\`/])(${REMOTE_PROGRAMS.join("|")})(\\s|$)`);

export function reachesServer(command) {
  return REMOTE.test(String(command || ""));
}

export function shellDecision(policy, command) {
  const rules = normalizePolicy(policy);
  const text = String(command || "");
  if (rules.shell === "allow" && !reachesServer(text)) return "allow";
  const listed = !CHAINING.test(text.replace(WORKSPACE_REDIRECT, ""))
    && rules.allow.some((pattern) => matchesPattern(pattern, text));
  if (listed) return "allow";
  return rules.shell === "deny" ? "deny" : "ask";
}

// Saved servers the bots can reach with ssh, from RAVNIR_SERVERS:
// "hub=This machine as ubuntu; veta=The veta VPS as ubuntu".
export function serverList(value = process.env.RAVNIR_SERVERS) {
  return String(value || "").split(";").map((item) => {
    const [name, ...rest] = item.split("=");
    return { name: name.trim(), about: rest.join("=").trim() };
  }).filter((item) => /^[\w.-]+$/.test(item.name));
}

// The allow-list rule saved when the user clicks "Always allow" on a command.
const PRESERVE_PROGRAMS = new Set([
  "ssh", "scp", "rsync", "sudo", "su", "sh", "bash", "zsh", "env", "eval",
  "exec", "xargs", "curl", "wget", "python", "python3", "node", "perl", "ruby",
  "docker", "podman", "kubectl", "rm", "chmod", "chown", "dd", "mkfs", "kill",
  "pkill", "killall", "systemctl", "crontab", "find",
]);
const SUBCOMMAND = /^[a-z][a-z0-9-]*$/;

export function suggestAlwaysRule(command) {
  const text = String(command || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (CHAINING.test(text.replace(WORKSPACE_REDIRECT, ""))) return "";
  if (CHAINING.test(text) || /['"]/.test(text)) return text;
  const tokens = text.split(" ");
  const program = tokens[0];
  if (PRESERVE_PROGRAMS.has(program.slice(program.lastIndexOf("/") + 1))) return text;
  const rest = [];
  for (let i = 1; i < tokens.length && rest.length < 2; i++) {
    if (!SUBCOMMAND.test(tokens[i])) break;
    rest.push(tokens[i]);
  }
  const base = [program, ...rest].join(" ");
  return rest.length === tokens.length - 1 ? base : `${base} *`;
}

// OpenCode applies its own bash and file tools. This maps the bot's rules onto
// the permission block in the bot's workspace opencode.json.
// OpenCode runs on the host, so its bash would run outside a bot's own
// computer. Those bots use run_command instead, which runs in the box and goes
// through the same rules.
export function openCodePermission(policy, { ownComputer = false } = {}) {
  const rules = normalizePolicy(policy);
  let bash = rules.shell;
  if (ownComputer) bash = "deny";
  else if (rules.shell !== "deny" && (rules.shell === "allow" || rules.allow.length)) {
    bash = { "*": rules.shell };
    if (rules.shell === "allow") for (const program of REMOTE_PROGRAMS) bash[`${program} *`] = "ask";
    for (const pattern of rules.allow) bash[pattern] = "allow";
  }
  return {
    bash,
    edit: "allow",
    webfetch: "allow",
    external_directory: rules.files,
    // OpenCode's own question tool waits for an answer through OpenCode, which nobody gives in Ravnir.
    // Denying it takes it off the model's list; agents ask the user with ask_user instead.
    question: "deny",
  };
}

export function describePolicy(policy) {
  const rules = normalizePolicy(policy);
  const shell = {
    allow: "Terminal commands run without asking.",
    ask: "Terminal commands wait for the user's approval.",
    deny: "Terminal commands are blocked.",
  }[rules.shell];
  const lines = [`- ${shell}`];
  if (rules.allow.length) {
    lines.push(`- These commands run without asking: ${rules.allow.map((item) => `\`${item}\``).join(", ")}. Chained commands (;, &&, |) always need approval.`);
  }
  if (rules.shell !== "deny") lines.push("- Commands that reach another machine (ssh, scp, sftp, rsync) always wait for approval unless that exact command is listed above.");
  lines.push({
    allow: "- You may read and write files outside your workspace.",
    ask: "- Reading or writing files outside your workspace waits for approval.",
    deny: "- You may not read or write files outside your workspace.",
  }[rules.files]);
  lines.push({
    allow: "- You may use saved logins without asking.",
    ask: "- Using a saved login waits for approval.",
    deny: "- You may not use saved logins.",
  }[rules.logins]);
  lines.push("- A request that waits for approval pauses your turn. If it is denied or times out, do not retry it or a variant; finish what you can without it and say what you could not check.");
  return lines.join("\n");
}

function escapeRegex(value) {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

// The decision for a tool on the user's Mac. Reads inside the Mac's work
// folders run; writes there follow the files rule; anything sensitive (keys,
// .env, keychains, sudo) always asks.
export function macDecision(policy, name, args, { home = "", roots = [] } = {}) {
  const rules = normalizePolicy(policy);
  if (name === "mac_status") return "allow";
  if (name === "mac_run") {
    const command = String(args?.command || "");
    const decision = shellDecision(rules, command);
    if (decision === "allow" && sensitiveMacCommand(command)) return "ask";
    return decision;
  }
  const file = String(args?.path || "").trim() || (name === "mac_list" ? "~/Desktop/Projects" : "");
  if (sensitiveMacPath(file) || sensitiveMacPath(expandHome(file, home))) return rules.files === "deny" ? "deny" : "ask";
  const inside = insideMacRoots(file, { home, roots });
  if (name !== "mac_write_file" && inside) return "allow";
  if (rules.files === "allow") return "allow";
  return rules.files === "deny" ? "deny" : "ask";
}

const MAC_TITLES = {
  mac_run: "Run a command on your Mac",
  mac_read_file: "Read a file on your Mac",
  mac_write_file: "Write a file on your Mac",
  mac_list: "List a folder on your Mac",
};

// Runs before a built-in tool. Returns when the action may go ahead, throws when it may not.
export async function guardTool(name, args, { bot, approvals, signal, meta = {}, onPolicyChange, mac = null }) {
  if (name.startsWith("mac_")) {
    const status = mac?.status?.() || {};
    const decision = macDecision(bot.policy, name, args, { home: status.home, roots: status.roots });
    if (decision === "allow") return;
    if (decision === "deny") throw new Error("This bot's rules block that on the Mac.");
    const command = String(args?.command || "");
    const rule = name === "mac_run" && !sensitiveMacCommand(command) ? suggestAlwaysRule(command) : "";
    const detail = name === "mac_run" ? `${args?.cwd || "~/Desktop/Projects"} $ ${command}` : String(args?.path || "~/Desktop/Projects");
    const answer = await approvals.request({ ...meta, bot, kind: name === "mac_run" ? "shell" : "files", title: MAC_TITLES[name], detail, rule, onceOnly: !rule, signal });
    if (answer === "reject") throw new Error("The user did not approve this on the Mac, or the request timed out.");
    if (answer === "always" && rule) {
      bot.policy = withAllowRule(bot.policy, rule);
      onPolicyChange?.(bot);
    }
    return;
  }
  if (name === "run_command") {
    const command = String(args?.command || "");
    const decision = shellDecision(bot.policy, command);
    if (decision === "allow") return;
    if (decision === "deny") throw new Error("This bot's rules block terminal commands.");
    const rule = suggestAlwaysRule(command);
    const answer = await approvals.request({ ...meta, bot, kind: "shell", title: "Run a terminal command", detail: command, rule, onceOnly: !rule, signal });
    if (answer === "reject") throw new Error("The user did not approve this command, or the request timed out.");
    if (answer === "always") {
      bot.policy = withAllowRule(bot.policy, rule);
      onPolicyChange?.(bot);
    }
    return;
  }
  if (name === "browser_saved_login" && normalizePolicy(bot.policy).logins === "deny") {
    throw new Error("This bot's rules block saved logins.");
  }
  if (name === "browser_saved_login" && normalizePolicy(bot.policy).logins !== "allow") {
    const answer = await approvals.request({ ...meta, bot, kind: "login", title: "Use a saved login", detail: String(args?.site || ""), signal });
    if (answer === "reject") throw new Error("The user did not approve using this login, or the request timed out.");
    if (answer === "always") {
      bot.policy = normalizePolicy({ ...bot.policy, logins: "allow" });
      onPolicyChange?.(bot);
    }
  }
}
