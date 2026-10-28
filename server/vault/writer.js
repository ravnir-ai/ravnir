import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { childEnv } from "../childEnv.js";
import { ownerLabel } from "../owner.js";
import { DECISIONS, FALLBACK_PROFILE, KEY_LABELS, STATUS_MARKERS, profileHead, profileNote, resolveLayout } from "./layout.js";
import { findSecret } from "./secrets.js";
import { PROPOSAL_TRAILER, REVERT_TRAILER, TURN_TRAILER, validHash } from "./history.js";

// The only code that writes to the shared vault. Every write is one small git commit made
// under the bot's own name, and the clone follows GitHub by rebase. It never force-pushes.

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 60000;
const SYNC_DELAY_MS = 10000;
const MIN_SYNC_MS = 30000;
const RAVNIR = { name: "Ravnir", email: "ravnir@ravnir.local" };
const AGENT = /^Agents\/[^/]+\.md$/;
const LOG = /^Decisions-Log\.md$/;
const PROJECT = /^Projects\/[^/]+\.md$/;
const PROPOSABLE = [PROJECT, /^Rules\.md$/];
const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const PROPOSAL_ONLY = "Only Rules.md and Projects/ changes go through proposals; you can write your own note, the daily log and the decision log directly.";

class WriteError extends Error {}

const fail = (message) => {
  throw new WriteError(message);
};
const oneLine = (text, max) => String(text ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
const field = (text) => oneLine(text, 200).replace(/\|/g, "/");
const errorText = (error) => String(error?.stderr || error?.message || error || "failed").trim().split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300);
const slugOf = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "bot";
const isHeading = (line) => /^#{1,6}\s/.test(line);
const levelOf = (line) => /^(#{1,6})\s/.exec(line)?.[1].length || 0;
const headingText = (line) => (/^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1] || "").trim();
const linesOf = (text) => String(text).replace(/\r\n/g, "\n").split("\n");

function sectionEnd(lines, start) {
  let end = start + 1;
  while (end < lines.length && !isHeading(lines[end])) end += 1;
  return end;
}

function appendToSection(lines, start, line) {
  let at = sectionEnd(lines, start);
  while (at > start + 1 && lines[at - 1].trim() === "") at -= 1;
  lines.splice(at, 0, line);
}

function appendLine(text, line) {
  return `${text.endsWith("\n") || !text ? text : `${text}\n`}${line}\n`;
}

export class VaultWriter {
  #chain = Promise.resolve();
  #timer = null;
  #interval = null;
  #lastSyncAt = null;
  #lastPushAt = null;
  #ahead = 0;
  #lastError = "";
  #conflicts = [];

  // layout is "auto", "en" or "es", or a function returning one; owner returns { name, language }.
  constructor({ vault, dir, sshCommand = "", branch = "master", remote = "origin", syncMs = 120000, proposals = null, notify = async () => {}, now = Date.now, timeZone = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone, git = "git", layout = "auto", owner = () => ({}), turnOf = () => "" } = {}) {
    this.vault = vault;
    this.dir = path.resolve(dir || ".");
    this.sshCommand = sshCommand;
    this.branch = branch;
    this.remote = remote;
    this.syncMs = syncMs;
    this.proposals = proposals;
    this.notify = notify;
    this.now = now;
    this.timeZone = timeZone;
    this.gitBin = git;
    this.layoutChoice = typeof layout === "function" ? layout : () => layout;
    this.owner = typeof owner === "function" ? owner : () => owner || {};
    // The turn a bot is in, so each commit links back to it (Ravnir-Turn trailer, the Memory page).
    this.turnOf = turnOf;
  }

  layout() {
    return resolveLayout(this.layoutChoice(), this.dir, this.owner()?.language);
  }

  profilePath() {
    return profileNote(this.layout(), this.dir, this.owner()?.name);
  }

  // What the prompt tells agents about where their writes land.
  describe() {
    const layout = this.layout();
    return { layout: layout.id, log: layout.log, profile: this.profilePath(), owner: ownerLabel(this.owner()) };
  }

  #paths() {
    const layout = this.layout();
    const day = new RegExp(`^${escapeRe(layout.log)}/\\d{4}-\\d{2}-\\d{2}\\.md$`);
    const profile = new RegExp(`^${escapeRe(this.profilePath())}$`);
    const fallback = new RegExp(`^${escapeRe(`${layout.people}/${FALLBACK_PROFILE}`)}$`);
    return { layout, day, profile, fallback, all: [AGENT, day, LOG, profile, fallback, ...PROPOSABLE] };
  }

  get available() {
    return Boolean(this.vault?.available) && fs.existsSync(path.join(this.dir, ".git"));
  }

  start() {
    if (this.#interval || !(this.syncMs > 0)) return;
    this.#interval = setInterval(() => this.sync().catch(() => {}), Math.max(MIN_SYNC_MS, this.syncMs));
    this.#interval.unref?.();
  }

  stop() {
    clearInterval(this.#interval);
    clearTimeout(this.#timer);
    this.#interval = null;
    this.#timer = null;
  }

  status() {
    return { available: this.available, lastSyncAt: this.#lastSyncAt, lastPushAt: this.#lastPushAt, ahead: this.#ahead, lastError: this.#lastError || null, conflicts: [...this.#conflicts] };
  }

  appendOwnNote(bot, text) {
    return this.#write(async () => {
      const body = this.#clean(text, 2000, "text");
      const rel = this.vault.noteForBot(bot) || `Agents/${this.#agentFile(bot)}.md`;
      return this.#edit(rel, [AGENT], this.#author(bot), "note", (before) => {
        const lines = linesOf(before ?? `# ${bot.name}\n\n`);
        const entry = `- ${this.#localDate()}: ${body}`;
        const at = lines.findIndex((line) => /^## Learned\s*$/.test(line));
        if (at === -1) return appendLine(lines.join("\n"), `\n## Learned\n${entry}`);
        appendToSection(lines, at, entry);
        return lines.join("\n");
      }, "", this.#turn(bot));
    });
  }

  logDecision(bot, text) {
    return this.#write(async () => {
      const body = this.#clean(text, 500, "text");
      const { layout } = this.#paths();
      const entry = layout.decisionLine(this.#localDate(), body, oneLine(bot.name, 100));
      return this.#edit(DECISIONS, [LOG], this.#author(bot), "decision", (before) => {
        const text = before ?? "# Decisions Log\n\n";
        const lines = linesOf(text);
        const heading = layout.decisionsBefore ? lines.findIndex((line) => line.trim() === layout.decisionsBefore || line.trim().startsWith(`${layout.decisionsBefore} `)) : -1;
        if (heading === -1) return appendLine(text, entry);
        let at = heading;
        while (at > 0 && lines[at - 1].trim() === "") at -= 1;
        lines.splice(at, 0, entry);
        if (lines[at + 1] !== "") lines.splice(at + 1, 0, "");
        return lines.join("\n");
      }, "", this.#turn(bot));
    });
  }

  logActivity(bot, { who, action, status, link } = {}) {
    return this.#write(async () => {
      const parts = [who || bot.name, action, status, link || ""].map((item) => {
        this.#scan(item);
        return field(item);
      });
      if (!parts[1] || !parts[2]) fail("An activity needs an action and a status.");
      const stamp = new Date(this.now()).toISOString();
      const date = stamp.slice(0, 10);
      const line = `- ${stamp.slice(11, 16)} UTC | ${parts[0]} | ${parts[1]} | ${parts[2]} | ${parts[3]}`;
      const { layout, day } = this.#paths();
      return this.#edit(`${layout.log}/${date}.md`, [day], this.#author(bot), "activity", (before) => appendLine(before ?? `${layout.logTitle(date)}\n\n`, line), "", this.#turn(bot));
    });
  }

  remember(bot, { fact, type = "fact", key = "" } = {}) {
    return this.#write(async () => {
      const { layout, profile, fallback } = this.#paths();
      const heading = layout.headings[type];
      if (!heading) fail(`Unknown type "${type}". Use preference, fact, contact, routine, goal or other.`);
      if (key && !/^[a-z0-9-]{1,40}$/.test(key)) fail("A key is 1-40 lowercase letters, digits or hyphens.");
      const body = this.#clean(fact, 300, "fact");
      const date = this.#localDate();
      const line = `- ${body} (${key ? `${layout.key}: ${key}, ` : ""}${date}, ${oneLine(bot.name, 100)})`;
      const HISTORY = layout.history;
      const labels = KEY_LABELS.join("|");
      const rel = this.profilePath();
      await this.#adoptProfile(layout, rel, [profile, fallback], this.#author(bot));
      return this.#edit(rel, [profile], this.#author(bot), "remember", (before) => {
        const lines = linesOf(before ?? profileHead(layout, this.owner()?.name));
        if (!lines.some((item) => item.trim() === HISTORY)) lines.push("", HISTORY, "");
        const [from, to] = this.#historyRange(lines, HISTORY);
        const outside = (index) => index < from || index >= to;
        const factOf = (item) => new RegExp(`^- (.*?)(?: \\((?:(?:${labels}): [^,)]+, )?\\d{4}-\\d{2}-\\d{2}, [^)]*\\))?\\s*$`).exec(item)?.[1]?.trim().toLowerCase();
        if (lines.some((item, index) => outside(index) && item.startsWith("- ") && factOf(item) === body.toLowerCase())) return before;
        const old = [];
        const kept = lines.filter((item, index) => {
          if (key && outside(index) && item.startsWith("- ") && KEY_LABELS.some((label) => item.includes(`(${label}: ${key},`))) {
            old.push(`- superseded ${date}: ${item.slice(2)}`);
            return false;
          }
          return true;
        });
        let at = kept.findIndex((item) => item.trim() === heading);
        if (at === -1) {
          kept.splice(kept.findIndex((item) => item.trim() === HISTORY), 0, heading, line, "");
        } else {
          appendToSection(kept, at, line);
        }
        at = kept.findIndex((item) => item.trim() === HISTORY);
        for (const item of old) appendToSection(kept, at, item);
        return kept.join("\n");
      }, "", this.#turn(bot));
    });
  }

  proposeChange(bot, { note, text, why = "", section = "" } = {}) {
    return this.#write(async () => {
      const body = this.#block(text, 4000);
      for (const item of [why, section]) this.#scan(item);
      if (!this.proposals) fail("Proposals are not enabled on this server.");
      const found = this.vault.resolve(String(note || ""));
      let rel = found;
      if (!rel) {
        const name = String(note || "").trim().replace(/^Projects\//, "").replace(/\.md$/, "");
        rel = name && !/[\\/]|\.\./.test(name) ? `Projects/${name}.md` : "";
      }
      if (!PROPOSABLE.some((re) => re.test(rel))) fail(PROPOSAL_ONLY);
      this.#safe(rel, PROPOSABLE);
      const heading = oneLine(section, 100);
      const preview = heading ? `Replace section "${heading}" in ${rel}:\n\n${body}` : `Append to ${rel}:\n\n${body}`;
      const baseHash = this.vault.read(rel)?.hash || "";
      const record = this.proposals.create({
        botId: bot.id,
        botName: bot.name,
        title: `${bot.name} proposes a change to ${rel}`,
        why: oneLine(why, 400),
        prompt: preview,
        kind: "vault",
        change: { note: rel, section: heading, text: body, baseHash },
        turnId: this.#turn(bot)[TURN_TRAILER] || "",
      });
      await Promise.resolve(this.notify({ kind: "proposal", botId: bot.id, botName: bot.name, title: "Vault change to approve", body: preview })).catch(() => {});
      return { ok: true, proposalId: record.id, path: rel };
    }, { sync: false });
  }

  applyProposal(record) {
    return this.#write(async () => {
      if (record?.kind !== "vault" || !record.change) fail("Not a vault proposal.");
      const { note, section, text } = record.change;
      const body = this.#block(text, 4000);
      const name = oneLine(record.botName, 100) || "Ravnir";
      const heading = oneLine(section, 100);
      this.#scan(heading);
      return this.#edit(String(note || ""), PROPOSABLE, { name, email: `${slugOf(name)}@ravnir.local` }, "", (before) => {
        const current = before ?? "";
        if (!heading) return `${current.endsWith("\n") || !current ? current : `${current}\n`}\n${body}\n`;
        const lines = linesOf(current);
        const at = lines.findIndex((line) => isHeading(line) && headingText(line).toLowerCase() === heading.toLowerCase());
        if (at === -1) return `${current.endsWith("\n") || !current ? current : `${current}\n`}\n## ${heading}\n${body}\n`;
        let end = at + 1;
        while (end < lines.length && !(isHeading(lines[end]) && levelOf(lines[end]) <= levelOf(lines[at]))) end += 1;
        lines.splice(at + 1, end - at - 1, ...body.split("\n"), ...(end < lines.length ? [""] : []));
        return lines.join("\n");
      }, `${name}: ${note} (approved by ${ownerLabel(this.owner())})`, { [PROPOSAL_TRAILER]: record.id, ...(record.turnId ? { [TURN_TRAILER]: record.turnId } : {}) });
    });
  }

  writeStatus(rel, text) {
    return this.#write(async () => {
      const body = String(text ?? "").replace(/\r\n/g, "\n").trim().slice(0, 4000);
      if (!body) fail("The status text is empty.");
      this.#scan(body);
      const { layout } = this.#paths();
      const block = `${layout.status[0]}\n${body}\n${layout.status[1]}`;
      return this.#edit(String(rel || ""), [PROJECT], RAVNIR_AUTHOR, "status", (before) => {
        const current = before ?? "";
        // A block written under either layout is replaced in place.
        for (const [open, close] of STATUS_MARKERS) {
          const start = current.indexOf(open);
          const end = start === -1 ? -1 : current.indexOf(close, start);
          if (end !== -1) return `${current.slice(0, start)}${block}${current.slice(end + close.length)}`;
        }
        const lines = linesOf(current);
        const at = lines.findIndex((line) => isHeading(line) && /^(estado actual|current status)$/i.test(headingText(line)));
        if (at === -1) return `${current.endsWith("\n") || !current ? current : `${current}\n`}\n${layout.statusHeading}\n${block}\n`;
        let stop = at + 1;
        while (stop < lines.length && !(isHeading(lines[stop]) && levelOf(lines[stop]) <= levelOf(lines[at]))) stop += 1;
        lines.splice(at + 1, stop - at - 1, ...block.split("\n"), ...(stop < lines.length ? [""] : []));
        return lines.join("\n");
      });
    });
  }

  // Undoes one commit with a new commit authored by the owner (git revert), so the log keeps both.
  // A commit a later change built on fails cleanly and leaves the vault as it was.
  revert(hash, { name = "", note = "" } = {}) {
    return this.#write(async () => {
      if (!validHash(hash)) fail("That is not a commit.");
      const full = (await this.#git(["rev-parse", "--verify", "-q", `${hash}^{commit}`]).catch(() => "")).trim();
      if (!full) fail("That commit is not in the vault.");
      if (!(await this.#git(["merge-base", "--is-ancestor", full, "HEAD"]).then(() => true, () => false))) fail("That commit is not on the vault's branch.");
      const parents = (await this.#git(["rev-list", "--parents", "-n", "1", full, "--"])).trim().split(/\s+/).slice(1);
      if (!parents.length) fail("The first commit of the vault cannot be reverted.");
      if (parents.length > 1) fail("A merge cannot be reverted from here.");
      const already = (await this.#git(["log", "--format=%h", `--grep=^${REVERT_TRAILER}: ${full}`, "HEAD", "--"])).trim();
      if (already) fail(`Already reverted by ${already.split("\n")[0]}.`);
      const subject = (await this.#git(["show", "-s", "--format=%s", full, "--"])).trim();
      const files = (await this.#git(["show", "--format=", "--name-only", "-z", full, "--"])).split("\0").filter(Boolean);
      // Never mixes the revert with edits someone made by hand (Obsidian) that are not committed yet.
      if ((await this.#git(["status", "--porcelain", "--untracked-files=no"])).trim()) fail("The vault has changes that are not committed yet. Try again after the next sync.");
      const owner = oneLine(name || ownerLabel(this.owner()), 100).replace(/[<>]/g, "") || "Owner";
      const author = { name: owner, email: `${slugOf(owner)}@ravnir.local` };
      try {
        await this.#git(["revert", "--no-commit", "--no-edit", full]);
      } catch {
        await this.#git(["revert", "--abort"]).catch(() => this.#git(["reset", "-q", "--merge"]).catch(() => {}));
        fail("A later change edited the same lines, so this one cannot be undone on its own. Revert the later change first.");
      }
      const why = oneLine(note, 300);
      const message = [`Revert "${subject}"`, "", `Reverted by ${owner} in Ravnir${why ? `: ${why}` : "."}`, "", `${REVERT_TRAILER}: ${full}`].join("\n");
      try {
        await this.#git(["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "-c", "commit.gpgsign=false", "commit", "--no-verify", "-q", "-m", message]);
      } catch (error) {
        await this.#git(["revert", "--abort"]).catch(() => this.#git(["reset", "-q", "--merge"]).catch(() => {}));
        throw error;
      }
      const commit = (await this.#git(["rev-parse", "--short", "HEAD"])).trim();
      return { ok: true, commit, reverted: full, files, path: files[0] || "" };
    });
  }

  sync() {
    return this.#locked(async () => {
      try {
        return await this.#sync();
      } catch (error) {
        this.#lastError = errorText(error);
        return { ok: false, error: this.#lastError };
      }
    });
  }

  // Runs fn with no write or sync in between (linking the vault to a remote switches its branch).
  exclusive(fn) {
    return this.#locked(fn);
  }

  #locked(fn) {
    const next = this.#chain.then(fn);
    this.#chain = next.catch(() => {});
    return next;
  }

  #write(fn, { sync = true } = {}) {
    return this.#locked(async () => {
      try {
        if (!this.available) fail("Vault writing is not enabled on this server.");
        const result = await fn();
        if (result.commit) {
          this.#ahead += 1;
          await this.vault.reindex();
        }
        if (sync && result.commit) this.#schedule();
        return result;
      } catch (error) {
        return { ok: false, error: error instanceof WriteError ? error.message : errorText(error) };
      }
    });
  }

  #schedule() {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.sync().catch(() => {}), SYNC_DELAY_MS);
    this.#timer.unref?.();
  }

  #scan(text) {
    const reason = findSecret(text);
    if (reason) fail(`Refused: ${reason}. Never put secrets in the vault.`);
  }

  #clean(text, max, label) {
    this.#scan(text);
    const value = oneLine(text, max);
    if (!value) fail(`The ${label} is empty.`);
    return value;
  }

  #block(text, max) {
    this.#scan(text);
    const value = String(text ?? "").replace(/\r\n?/g, "\n").trim().slice(0, max);
    if (!value) fail("The text is empty.");
    return value;
  }

  #turn(bot) {
    const id = String(this.turnOf(bot) || "").trim();
    return /^[\w-]{1,80}$/.test(id) ? { [TURN_TRAILER]: id } : {};
  }

  #author(bot) {
    const name = oneLine(bot?.name, 100).replace(/[<>]/g, "");
    if (!name) fail("The bot has no name.");
    return { name, email: `${slugOf(name)}@ravnir.local` };
  }

  #agentFile(bot) {
    const name = oneLine(bot?.name, 100).replace(/[\\/:*?"<>|.]/g, "").replace(/\s+/g, "-");
    if (!name) fail("The bot has no name.");
    return name;
  }

  #localDate() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: this.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(this.now()));
  }

  #historyRange(lines, history) {
    const from = lines.findIndex((line) => line.trim() === history);
    return [from, from === -1 ? -1 : sectionEnd(lines, from)];
  }

  #safe(rel, allowed) {
    const value = String(rel || "");
    if (!value || path.isAbsolute(value) || value.includes("\\") || value.split("/").includes("..") || !value.endsWith(".md")) fail("That path is not allowed in the vault.");
    if (!this.#paths().all.some((re) => re.test(value)) || !allowed.some((re) => re.test(value))) fail("That path is not allowed in the vault.");
    const root = fs.realpathSync(this.dir);
    let current = this.dir;
    for (const part of value.split("/")) {
      current = path.join(current, part);
      let stat;
      try {
        stat = fs.lstatSync(current);
      } catch {
        break;
      }
      if (stat.isSymbolicLink()) fail("That path is not allowed in the vault.");
    }
    let probe = path.join(this.dir, value);
    while (!fs.existsSync(probe)) probe = path.dirname(probe);
    const real = fs.realpathSync(probe);
    if (real !== root && !real.startsWith(root + path.sep)) fail("That path is not allowed in the vault.");
    return path.join(this.dir, value);
  }

  // Facts saved before the owner set a name sit in the fallback note; the first write
  // after that moves them to the named note in one commit.
  async #adoptProfile(layout, rel, [profile, fallback], author) {
    const old = `${layout.people}/${FALLBACK_PROFILE}`;
    if (rel === old) return;
    const from = this.#safe(old, [fallback]);
    const to = this.#safe(rel, [profile]);
    if (!fs.existsSync(from) || fs.existsSync(to)) return;
    const name = this.owner()?.name;
    const text = fs.readFileSync(from, "utf8");
    fs.writeFileSync(to, text.replace(/^# Owner$/m, () => `# ${name}`).replace("Durable facts about the owner ", () => `Durable facts about ${name} `));
    fs.rmSync(from);
    try {
      await this.#git(["add", "-A", "--", old, rel]);
      await this.#git(["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "-c", "commit.gpgsign=false", "commit", "--no-verify", "-q", "-m", `${author.name}: profile ${old} is now ${rel}`, "--", old, rel]);
    } catch (error) {
      fs.writeFileSync(from, text);
      fs.rmSync(to, { force: true });
      await this.#git(["reset", "-q", "--", old, rel]).catch(() => {});
      throw error;
    }
  }

  async #edit(rel, allowed, author, op, transform, message = "", trailers = {}) {
    const abs = this.#safe(rel, allowed);
    const before = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
    const after = transform(before);
    if (after === before) return { ok: true, path: rel, unchanged: true };
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, after);
    try {
      await this.#git(["add", "--", rel]);
      const staged = await this.#git(["diff", "--cached", "--name-only", "--", rel]);
      if (!staged.trim()) return { ok: true, path: rel, unchanged: true };
      await this.#git(["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "-c", "commit.gpgsign=false", "commit", "--no-verify", "-q", "-m", message || `${author.name}: ${op} ${rel}`, ...trailerArgs(trailers), "--", rel]);
    } catch (error) {
      if (before === null) fs.rmSync(abs, { force: true });
      else fs.writeFileSync(abs, before);
      await this.#git(["reset", "-q", "--", rel]).catch(() => {});
      throw error;
    }
    const commit = (await this.#git(["rev-parse", "--short", "HEAD"])).trim();
    return { ok: true, path: rel, commit };
  }

  async #git(args, { env = {}, timeout = GIT_TIMEOUT_MS } = {}) {
    // Git runs hooks from the clone, which a bot on this server could write to.
    const merged = childEnv({ SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK, GIT_TERMINAL_PROMPT: "0", GIT_COMMITTER_NAME: RAVNIR.name, GIT_COMMITTER_EMAIL: RAVNIR.email, ...env });
    if (this.sshCommand) merged.GIT_SSH_COMMAND = this.sshCommand;
    const { stdout } = await run(this.gitBin, ["-C", this.dir, ...args], { env: merged, timeout, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  }

  #ensureAttributes() {
    const file = path.join(this.dir, ".git", "info", "attributes");
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const have = new Set(current.split("\n").map((line) => line.trim()));
    const layout = this.layout();
    const missing = [`${DECISIONS} merge=union`, `${layout.log}/*.md merge=union`, `${layout.people}/*.md merge=union`].filter((line) => !have.has(line));
    if (!missing.length) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  }

  async #counts() {
    const out = await this.#git(["rev-list", "--left-right", "--count", `HEAD...${this.remote}/${this.branch}`]);
    const [ahead, behind] = out.trim().split(/\s+/).map(Number);
    return { ahead: ahead || 0, behind: behind || 0 };
  }

  async #rebase() {
    try {
      await this.#git(["rebase", "--autostash", `${this.remote}/${this.branch}`], { env: { GIT_EDITOR: "true" } });
      return true;
    } catch {
      await this.#git(["rebase", "--abort"]).catch(() => {});
      return false;
    }
  }

  async #sync() {
    if (!this.available) return { ok: false, error: "Vault writing is not enabled on this server." };
    this.#ensureAttributes();
    // A vault with no remote yet (a fresh install) keeps its commits here; there is nothing to sync.
    if (!(await this.#git(["remote"])).split("\n").map((line) => line.trim()).includes(this.remote)) {
      this.#ahead = 0;
      this.#lastError = "";
      this.#lastSyncAt = new Date(this.now()).toISOString();
      return { ok: true, ahead: 0, local: true };
    }
    const before = (await this.#git(["rev-parse", "HEAD"])).trim();
    try {
      await this.#git(["fetch", "--quiet", this.remote, this.branch]);
    } catch (error) {
      this.#lastError = errorText(error);
      return { ok: false, error: this.#lastError };
    }
    let { ahead, behind } = await this.#counts();
    let conflict = "";
    if (behind && !ahead) {
      await this.#git(["merge", "--ff-only", "--quiet", `${this.remote}/${this.branch}`]);
      behind = 0;
    } else if (behind) {
      if (!(await this.#rebase())) conflict = await this.#saveConflict();
    }
    ({ ahead } = await this.#counts());
    this.#lastError = "";
    if (ahead) {
      try {
        await this.#push();
        this.#lastPushAt = new Date(this.now()).toISOString();
        ahead = 0;
      } catch (error) {
        this.#lastError = errorText(error);
      }
    }
    this.#ahead = ahead;
    this.#lastSyncAt = new Date(this.now()).toISOString();
    if ((await this.#git(["rev-parse", "HEAD"])).trim() !== before) await this.vault.reindex();
    return { ok: !this.#lastError, ahead, conflict: conflict || undefined, error: this.#lastError || undefined };
  }

  async #push() {
    const push = () => this.#git(["push", "--quiet", this.remote, `HEAD:${this.branch}`]);
    try {
      await push();
    } catch (first) {
      await this.#git(["fetch", "--quiet", this.remote, this.branch]);
      if (!(await this.#rebase())) throw first;
      await push();
    }
  }

  async #saveConflict() {
    const stamp = new Date(this.now()).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13);
    let name = `ravnir/conflicto-${stamp}`;
    for (let n = 2; await this.#git(["rev-parse", "--verify", "-q", `refs/heads/${name}`]).then(() => true, () => false); n += 1) name = `ravnir/conflicto-${stamp}-${n}`;
    const dirty = (await this.#git(["status", "--porcelain", "--untracked-files=no"])).trim();
    await this.#git(["branch", name]);
    await this.#git(["push", "--quiet", this.remote, `${name}:refs/heads/${name}`]);
    if (dirty) await this.#git(["stash", "push", "--quiet"]);
    await this.#git(["reset", "--hard", "--quiet", `${this.remote}/${this.branch}`]);
    if (dirty) await this.#git(["stash", "pop", "--quiet"]).catch(() => {});
    this.#conflicts.push(name);
    await Promise.resolve(this.notify({ kind: "failure", priority: "high", title: "Vault conflict", body: `Ravnir's vault changes clashed with GitHub. They are saved on branch ${name}; the vault now follows GitHub again.` })).catch(() => {});
    return name;
  }
}

const RAVNIR_AUTHOR = { name: RAVNIR.name, email: RAVNIR.email };

function trailerArgs(trailers = {}) {
  return Object.entries(trailers).filter(([, value]) => value).flatMap(([key, value]) => ["--trailer", `${key}: ${oneLine(value, 120)}`]);
}
