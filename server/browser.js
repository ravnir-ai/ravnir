import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { childEnv } from "./childEnv.js";
import { detectBlock, hostOf } from "./netRoute.js";
import { browserProfilePath, botHome } from "./state.js";

export const VIEWPORT = { width: 1440, height: 900 };
// Headful Chrome on a 1440x900 Xvfb screen loses the browser chrome from the
// page viewport. Keep a page viewport that fits inside the window so pages can
// scroll instead of being clipped under the toolbar.
export const PAGE_VIEWPORT = { width: 1440, height: 786 };
const DEFAULT_TIMEOUT = 20_000;
// How long a bot check that a real browser can pass gets to clear by itself.
const CHALLENGE_WAIT_MS = 12_000;
// A page with less text than this right after it loads gets a moment for its scripts.
const THIN_PAGE_CHARS = 200;
const THIN_PAGE_WAIT_MS = 5_000;
// A click that opens a page starts its request within this time.
const CLICK_NAVIGATION_MS = 600;

// What every browser and computer tool says while the user has the browser.
export const HANDED_OVER_MESSAGE = "The user is using the browser right now. Wait for them to hand it back.";

export class HandedOverError extends Error {
  constructor() {
    super(HANDED_OVER_MESSAGE);
    this.name = "HandedOverError";
    this.handedOver = true;
    this.status = 409;
  }
}

export class BrowserManager {
  constructor({ home, desktop = null, box = null, network = null }) {
    this.home = home;
    this.desktop = desktop;
    // Where each agent's browser opens sites from (server/netRoute.js).
    this.network = network;
    // A bot with its own computer (server/box.js) gets the browser inside it.
    this.box = box;
    this.sessions = new Map();
    this.pending = new Map();
    // Set by closeAll: the server is going away, so no new browser may stay open.
    this.shutdown = false;
    // Bots whose browser the user has taken (server/live.js, "Sign in yourself").
    this.held = new Map();
    // Bot id -> the browser tool in progress (see exclusive()).
    this.locks = new Map();
  }

  // Runs fn once the bot's previous browser tool has finished. Each agent has one
  // tab, and a model can call several browser tools at once: without this, a
  // second page.goto cancels the first (net::ERR_ABORTED) or a read returns the
  // other call's page. Not re-entrant: fn must not call exclusive() for the same bot.
  exclusive(botId, fn) {
    const next = (this.locks.get(botId) || Promise.resolve()).then(fn, fn);
    const settled = next.catch(() => {});
    this.locks.set(botId, settled);
    settled.then(() => {
      if (this.locks.get(botId) === settled) this.locks.delete(botId);
    });
    return next;
  }

  // While held, nothing may open, read or drive the bot's browser: the user is
  // signing in through a plain browser on the same profile.
  hold(botId, info = {}) {
    this.held.set(botId, { startedAt: Date.now(), ...info });
  }

  release(botId) {
    this.held.delete(botId);
  }

  isHeld(botId) {
    return this.held.has(botId);
  }

  status(bot) {
    const session = this.sessions.get(bot.id);
    if (session) return { ...session.status(), handedOver: this.isHeld(bot.id) };
    if (this.box?.uses(bot)) {
      return {
        handedOver: this.isHeld(bot.id),
        running: false,
        available: true,
        engine: "box",
        executable: "Chromium in the bot's own computer",
        url: "about:blank",
        title: "",
        error: "",
        viewport: PAGE_VIEWPORT,
        desktop: this.desktop?.status(bot) || null,
      };
    }
    const executable = findChromium();
    return {
      handedOver: this.isHeld(bot.id),
      running: false,
      available: Boolean(executable) || Boolean(systemChrome()),
      engine: "playwright",
      executable: executable || systemChrome() || "",
      url: "about:blank",
      title: "",
      error: executable || systemChrome() ? "" : "Playwright Chromium is not installed on this server.",
      viewport: VIEWPORT,
      desktop: this.desktop?.status(bot) || null,
    };
  }

  // `force` is for server/live.js only: it relaunches the agent's browser while
  // the hold is still on, so no tool can slip in before the page is restored.
  async ensure(bot, { force = false } = {}) {
    if (!force && this.isHeld(bot.id)) throw new HandedOverError();
    const existing = this.sessions.get(bot.id);
    if (existing && existing.alive()) return existing;
    if (existing) this.sessions.delete(bot.id);
    if (this.pending.has(bot.id)) return this.pending.get(bot.id);
    const promise = (async () => {
      const session = new BrowserSession({
        bot,
        home: this.home,
        desktop: this.desktop,
        box: this.box?.uses(bot) ? this.box : null,
        network: this.box?.uses(bot) ? null : this.network,
        profile: browserProfilePath(this.home, bot),
        stateFile: path.join(botHome(this.home, bot), "browser.json"),
        downloads: path.join(botHome(this.home, bot), "downloads"),
      });
      await session.launch();
      // The server shut down while this browser was starting: close it instead of leaving it running.
      if (this.shutdown) {
        await session.close().catch(() => {});
        throw new Error("The server is shutting down.");
      }
      this.sessions.set(bot.id, session);
      return session;
    })();
    this.pending.set(bot.id, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(bot.id);
    }
  }

  desktopEnv(bot) {
    return this.desktop?.envFor(bot) || {};
  }

  async close(botId) {
    const session = this.sessions.get(botId);
    if (!session) return;
    this.sessions.delete(botId);
    await session.close();
  }

  async closeAll() {
    this.shutdown = true;
    // A browser still starting is closed when its launch finishes (ensure checks shutdown).
    await Promise.allSettled([...this.pending.values()]);
    await Promise.all([...this.sessions.values()].map((session) => session.close()));
    this.sessions.clear();
    this.network?.closeAll();
    await this.desktop?.closeAll();
  }
}

export class BrowserSession {
  constructor({ bot, home, desktop = null, box = null, network = null, profile, stateFile, downloads }) {
    this.bot = bot;
    this.home = home;
    this.desktop = desktop;
    this.box = box;
    this.network = network;
    // The main frame's last document response, for spotting block pages.
    this.lastMain = null;
    // A line for the agent about how the last page was reached (or why it was not).
    this.notice = "";
    this.cdp = null;
    this.profile = profile;
    this.stateFile = stateFile;
    this.downloads = downloads;
    this.context = null;
    this.page = null;
    this.url = "about:blank";
    this.title = "";
    this.error = "";
    this.closed = false;
    this.lastShot = null;
    this.lastShotAt = 0;
    this.shotPromise = null;
    this.lastStateSave = 0;
  }

  alive() {
    return Boolean(!this.closed && this.context && this.page && !this.page.isClosed());
  }

  status() {
    return {
      running: this.alive(),
      available: true,
      engine: this.box ? "box" : "playwright",
      executable: this.box ? "Chromium in the bot's own computer" : findChromium() || systemChrome() || "",
      url: this.url,
      title: this.title,
      error: this.error,
      viewport: this.viewport || VIEWPORT,
      desktop: this.desktop?.status(this.bot) || null,
    };
  }

  async launch() {
    this.closed = false;
    if (this.box) return this.#connectToBox();
    fs.mkdirSync(this.profile, { recursive: true });
    fs.mkdirSync(this.downloads, { recursive: true });
    this.#clearStaleProfile();
    const executable = findChromium();
    const options = {
      headless: true,
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      acceptDownloads: true,
      locale: "en-US",
      args: ["--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage"],
      // Playwright would hand the browser the whole server environment.
      env: childEnv(),
    };
    if (process.env.RAVNIR_CHROMIUM_NO_SANDBOX === "1") options.args.push("--no-sandbox");
    const proxy = await this.network?.launchProxy(this.bot);
    if (proxy) options.proxy = proxy;
    if (executable) options.executablePath = executable;
    else options.channel = "chrome";

    // On Linux with Xvfb, run the real browser on a visible desktop. The bot
    // can then use GUI apps too, and the user can watch the whole desktop.
    const desktop = await this.desktop?.ensure(this.bot, this.home).catch(() => null);
    if (desktop) {
      options.headless = false;
      options.env = desktop.env;
      options.viewport = PAGE_VIEWPORT;
      options.args.push("--window-position=0,0", `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, "--start-maximized");
    }
    this.viewport = options.viewport || VIEWPORT;

    try {
      this.context = await chromium.launchPersistentContext(this.profile, options);
    } catch (error) {
      if (desktop) {
        await this.desktop.close(this.bot.id).catch(() => {});
        options.headless = true;
        options.env = childEnv();
        options.args = options.args.filter((arg) => !arg.startsWith("--window-") && arg !== "--start-maximized");
        try {
          this.context = await chromium.launchPersistentContext(this.profile, options);
        } catch (fallback) {
          logLaunchError(this.bot, error);
          logLaunchError(this.bot, fallback);
          this.error = describeLaunchError(fallback);
          this.closed = true;
          throw new Error(this.error);
        }
      } else {
        logLaunchError(this.bot, error);
        this.error = describeLaunchError(error);
        this.closed = true;
        throw new Error(this.error);
      }
    }
    return this.#wire();
  }

  // The browser of a bot with its own computer runs inside the box and keeps
  // running between connections, so the open page is kept as it was.
  async #connectToBox() {
    try {
      const endpoint = await this.box.browserEndpoint(this.bot);
      this.cdp = await chromium.connectOverCDP(endpoint, { timeout: DEFAULT_TIMEOUT });
    } catch (error) {
      this.error = `The browser in ${this.bot.name}'s computer did not connect. ${String(error.message || error).split("\n")[0]}`;
      this.closed = true;
      throw new Error(this.error);
    }
    this.cdp.on("disconnected", () => {
      this.closed = true;
    });
    this.context = this.cdp.contexts()[0] || await this.cdp.newContext();
    this.viewport = PAGE_VIEWPORT;
    return this.#wire({ fresh: false });
  }

  async #wire({ fresh = true } = {}) {
    this.context.setDefaultTimeout(DEFAULT_TIMEOUT);
    this.context.setDefaultNavigationTimeout(DEFAULT_TIMEOUT);
    this.page = this.context.pages()[0] || await this.context.newPage();
    if (this.box) await this.page.setViewportSize(PAGE_VIEWPORT).catch(() => {});
    this.page.on("framenavigated", (frame) => {
      if (frame === this.page.mainFrame()) {
        this.url = frame.url();
        this.#saveState();
      }
    });
    this.page.on("load", () => {
      this.#saveState();
    });
    // The route proxy needs to know which site the page is on before its pieces load.
    this.page.on("request", (request) => {
      try {
        if (this.network && request.isNavigationRequest() && request.frame() === this.page.mainFrame()) this.network.setPage(this.bot, request.url());
      } catch {
        // A request from a page that just closed.
      }
    });
    this.page.on("response", (response) => {
      try {
        if (!response.request().isNavigationRequest() || response.frame() !== this.page.mainFrame()) return;
        this.lastMain = { url: response.url(), status: response.status(), headers: response.headers(), at: Date.now() };
      } catch {
        // A response from a page that just closed.
      }
    });
    // Downloads of a box browser land in the box (~/Downloads); the host path
    // Playwright would pick does not exist there.
    if (!this.box) {
      this.page.on("download", async (download) => {
        try {
          await download.saveAs(path.join(this.downloads, safeName(download.suggestedFilename())));
        } catch {
          // Ignore a failed download.
        }
      });
    }
    this.context.on("close", () => {
      this.closed = true;
    });
    await this.page.bringToFront().catch(() => {});
    if (fresh) await this.page.goto("about:blank").catch(() => {});
    await this.refreshMeta();
    this.error = "";
    return this;
  }

  // A tab of its own for a quick job (a web search), closed afterwards. The
  // agent's page, its address and its saved state are never touched.
  async withScratchPage(fn) {
    const page = await this.context.newPage();
    page.setDefaultNavigationTimeout(DEFAULT_TIMEOUT);
    try {
      return await fn(page);
    } finally {
      await page.close().catch(() => {});
      await this.page?.bringToFront().catch(() => {});
    }
  }

  async navigate(url, { quiet = false } = {}) {
    const target = normalizeUrl(url);
    if (!target) throw new Error("Use an http or https address.");
    this.#tell("", "");
    await this.#goto(target);
    // A page that draws itself with JavaScript is nearly empty at first: let its requests finish.
    const shown = await this.page.evaluate(() => (document.body?.innerText || "").trim().length).catch(() => 0);
    if (shown < THIN_PAGE_CHARS) await this.page.waitForLoadState("networkidle", { timeout: THIN_PAGE_WAIT_MS }).catch(() => {});
    let block = await this.#blockHere({ wait: true });
    if (block && this.network) {
      const host = hostOf(this.page.url()) || hostOf(target);
      // A site that refuses this server's network: open it again from the Mac.
      if (this.network.canMoveHome(this.bot, host)) {
        this.network.moveHome(this.bot, host, block);
        await this.#goto(target);
        const after = await this.#blockHere({ wait: true });
        if (!after) this.#tell(host, this.network.openedNote(this.bot, host, block));
        block = after;
      }
      if (block) this.#tell(host, this.network.explain(this.bot, host, block));
    }
    await this.refreshMeta();
    if (!quiet) this.#saveState();
    return this.status();
  }

  #tell(host, text) {
    this.noticeHost = host;
    this.notice = text;
  }

  async #goto(target) {
    try {
      await this.page.goto(target, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
    } catch (error) {
      // A connection the route proxy could not open: say why in plain words.
      const plain = /ERR_SOCKS|ERR_PROXY|ERR_TUNNEL/.test(String(error.message)) ? this.network?.connectError(this.bot, hostOf(target)) : "";
      if (plain) throw new Error(plain);
      throw error;
    }
  }

  // The bot-protection page on screen, if any. With `wait`, gives a check that a
  // real browser can pass (Cloudflare's "Just a moment") a few seconds to clear.
  async #blockHere({ wait = false } = {}) {
    const look = async () => {
      const main = this.lastMain && hostOf(this.lastMain.url) === hostOf(this.page.url()) ? this.lastMain : null;
      const title = await this.page.title().catch(() => "");
      const text = await this.page.evaluate(() => (document.body?.innerText || "").slice(0, 1500)).catch(() => "");
      return detectBlock({ status: main?.status || 0, headers: main?.headers || {}, title, text });
    };
    let block = await look();
    if (block?.kind === "challenge" && wait) {
      const until = Date.now() + CHALLENGE_WAIT_MS;
      while (block?.kind === "challenge" && Date.now() < until) {
        await this.page.waitForTimeout(1_000);
        block = await look();
      }
    }
    return block;
  }

  async refreshMeta() {
    try {
      this.url = this.page.url();
      this.title = await this.page.title();
    } catch {
      // Between navigations.
    }
    return this.status();
  }

  async goBack() {
    await this.page.goBack({ waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => {});
    await this.refreshMeta();
    return this.status();
  }

  async goForward() {
    await this.page.goForward({ waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => {});
    await this.refreshMeta();
    return this.status();
  }

  async reload() {
    await this.page.reload({ waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT }).catch(() => {});
    await this.refreshMeta();
    return this.status();
  }

  async screenshot({ force = false } = {}) {
    const now = Date.now();
    if (!force && this.lastShot && now - this.lastShotAt < 350) return this.lastShot;
    if (this.shotPromise) return this.shotPromise;
    this.shotPromise = (async () => {
      try {
        // A headful window that another app covers can make Chromium refuse
        // Page.captureScreenshot. Bring it to the front first, then fall back
        // to the X display if the renderer still refuses.
        await this.page.bringToFront().catch(() => {});
        let shot = null;
        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            shot = await this.page.screenshot({ type: "png", animations: "disabled", timeout: 15_000 });
            break;
          } catch (error) {
            lastError = error;
            if (attempt === 0) await this.page.waitForTimeout(200).catch(() => {});
          }
        }
        if (!shot) throw lastError;
        this.lastShot = shot;
        this.lastShotAt = Date.now();
        return this.lastShot;
      } catch (error) {
        const fallback = await this.#desktopScreenshot().catch(() => null);
        if (fallback) {
          this.lastShot = fallback;
          this.lastShotAt = Date.now();
          return fallback;
        }
        if (this.lastShot) return this.lastShot;
        throw new Error(`The browser did not produce a screenshot for ${this.bot.name} at ${this.url || "about:blank"}. ${error.message.split("\n")[0]}`);
      } finally {
        this.shotPromise = null;
      }
    })();
    return this.shotPromise;
  }

  async #desktopScreenshot() {
    if (!this.desktop) return null;
    const png = await this.desktop.screenshot(this.bot, { force: true });
    if (!png) return null;
    const dir = path.join(botHome(this.home, this.bot), "desktop");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const source = path.join(dir, `fallback-${stamp}.png`);
    const cropped = path.join(dir, `fallback-crop-${stamp}.png`);
    fs.writeFileSync(source, png);
    try {
      await new Promise((resolve, reject) => {
        execFile("ffmpeg", [
          "-loglevel", "error",
          "-i", source,
          "-vf", `crop=${PAGE_VIEWPORT.width}:${PAGE_VIEWPORT.height}:0:${VIEWPORT.height - PAGE_VIEWPORT.height}`,
          "-frames:v", "1",
          "-y", cropped,
        ], (error) => (error ? reject(error) : resolve()));
      });
      return fs.readFileSync(cropped);
    } finally {
      try { fs.unlinkSync(source); } catch { /* ignore */ }
      try { fs.unlinkSync(cropped); } catch { /* ignore */ }
    }
  }

  async click(x, y) {
    await this.#settleAfter(async () => {
      await this.page.mouse.move(x, y);
      await this.page.mouse.click(x, y);
    });
    await this.refreshMeta();
    return this.status();
  }

  // Runs a click and, when it opens another page, waits for that page to load,
  // so the read that follows is of the new page and not the one clicked on.
  async #settleAfter(action) {
    const page = this.page;
    const main = page.mainFrame();
    let started = null;
    let finish;
    const landed = new Promise((resolve) => {
      finish = resolve;
    });
    const onRequest = (request) => {
      try {
        if (!started && request.isNavigationRequest() && request.frame() === main) started = request;
      } catch {
        // A request from a page that just closed.
      }
    };
    const onNavigated = (frame) => {
      if (frame === main && started) finish(true);
    };
    // A download or a refused request: no new page is coming.
    const onFailed = (request) => {
      if (started && request === started) finish(false);
    };
    page.on("request", onRequest);
    page.on("framenavigated", onNavigated);
    page.on("requestfailed", onFailed);
    try {
      await action();
      const until = Date.now() + CLICK_NAVIGATION_MS;
      while (!started && Date.now() < until) await page.waitForTimeout(50);
      if (!started) {
        await page.waitForTimeout(250);
        return;
      }
      let timer;
      await Promise.race([landed, new Promise((resolve) => {
        timer = setTimeout(resolve, DEFAULT_TIMEOUT);
      })]);
      clearTimeout(timer);
      await page.waitForLoadState("domcontentloaded", { timeout: DEFAULT_TIMEOUT }).catch(() => {});
    } finally {
      page.off("request", onRequest);
      page.off("framenavigated", onNavigated);
      page.off("requestfailed", onFailed);
    }
  }

  async typeText(text) {
    await this.page.keyboard.insertText(String(text));
    await this.page.waitForTimeout(120);
    return this.status();
  }

  async key(name) {
    await this.page.keyboard.press(name);
    await this.page.waitForTimeout(150);
    return this.status();
  }

  async clickSelector(selector) {
    const locator = this.page.locator(selector).first();
    if (!(await locator.count())) throw new Error(`No element matches ${selector}.`);
    await locator.scrollIntoViewIfNeeded();
    await this.#settleAfter(() => locator.click({ timeout: 8000 }));
    await this.refreshMeta();
    return this.status();
  }

  async typeSelector(selector, text) {
    const locator = this.page.locator(selector).first();
    if (!(await locator.count())) throw new Error(`No element matches ${selector}.`);
    const kind = await locator.evaluate((el) => (el.tagName === "SELECT" ? "select" : el.type === "checkbox" || el.type === "radio" ? el.type : "text"));
    const value = String(text);
    if (kind === "select") {
      // A dropdown takes one of its options, by the text shown or by its value, in any case.
      const options = await locator.evaluate((el) => [...el.options].map((option) => ({ label: option.label || option.text, value: option.value })));
      const wanted = value.trim().toLowerCase();
      const match = options.find((option) => option.label.trim().toLowerCase() === wanted || option.value.toLowerCase() === wanted)
        || options.find((option) => option.label.trim().toLowerCase().includes(wanted));
      if (!match) throw new Error(`No option "${value}" in that dropdown. Options: ${options.map((option) => option.label.trim()).join(", ")}.`);
      await locator.selectOption({ value: match.value });
    } else if (kind === "checkbox" || kind === "radio") {
      const on = !/^(no|false|off|0|uncheck|unchecked)$/i.test(value.trim());
      await locator.setChecked(kind === "radio" ? true : on);
    } else {
      await locator.fill(value);
    }
    return this.status();
  }

  async evaluate(script) {
    return this.page.evaluate(script);
  }

  async pause(ms = 400) {
    await this.page.waitForTimeout(ms).catch(() => {});
  }

  async read() {
    const result = await this.page.evaluate(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 1 && rect.height > 1 && style.visibility !== "hidden" && style.display !== "none";
      };
      const label = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.name || "").replace(/\s+/g, " ").trim().slice(0, 100);
      // A field's own label (<label for>), so the agent knows what goes where.
      const fieldLabel = (el) => ([...(el.labels || [])].map((item) => item.innerText).join(" ") || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.name || "").replace(/\s+/g, " ").trim().slice(0, 100);
      // Numbers from an earlier read would point at the wrong element now.
      for (const el of document.querySelectorAll("[data-ravnir-action],[data-ravnir-field]")) {
        el.removeAttribute("data-ravnir-action");
        el.removeAttribute("data-ravnir-field");
      }
      const fields = [...document.querySelectorAll("input,textarea,select")].filter((el) => visible(el) || el.type === "checkbox" || el.type === "radio").filter((el) => el.type !== "hidden").slice(0, 40).map((el, index) => {
        el.setAttribute("data-ravnir-field", String(index));
        return {
          i: index,
          selector: `[data-ravnir-field="${index}"]`,
          css: el.id ? `#${CSS.escape(el.id)}` : el.name ? `${el.tagName.toLowerCase()}[name="${el.name}"]` : `[data-ravnir-field="${index}"]`,
          fieldLabel: fieldLabel(el),
          options: el.tagName === "SELECT" ? [...el.options].map((option) => (option.label || option.text).trim()).slice(0, 30) : undefined,
          selected: el.tagName === "SELECT" ? (el.selectedOptions?.[0]?.label || el.selectedOptions?.[0]?.text || "").trim() : undefined,
          checked: el.type === "checkbox" || el.type === "radio" ? el.checked : undefined,
          tag: el.tagName.toLowerCase(),
          type: el.type || "",
          name: el.name || "",
          placeholder: el.placeholder || "",
          label: label(el),
          value: el.type === "password" ? "" : String(el.value || "").slice(0, 120),
        };
      });
      // What can be clicked: links, buttons and their ARIA roles, plus the cards and
      // divs a site makes clickable with a script (an onclick, a tabindex, or the
      // pointer cursor on the outermost element that has it).
      const CLICKABLE = "button,a,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],input[type=submit],input[type=button],summary,[onclick],[tabindex]:not([tabindex='-1'])";
      const NATIVE = /^(A|BUTTON|INPUT|SUMMARY)$/;
      const textOf = (el) => (el.innerText || "").trim();
      const listed = [...document.querySelectorAll(CLICKABLE)]
        .filter((el) => visible(el) && (NATIVE.test(el.tagName) || textOf(el).length <= 300));
      const known = new Set(listed);
      const all = document.body ? document.body.querySelectorAll("*") : [];
      for (let index = 0; index < Math.min(all.length, 5000); index += 1) {
        const el = all[index];
        if (known.has(el) || getComputedStyle(el).cursor !== "pointer") continue;
        if (el.parentElement && getComputedStyle(el.parentElement).cursor === "pointer") continue;
        const text = textOf(el);
        if (!text || text.length > 300) continue;
        if (el.closest("button,a,[role=button],[role=link],summary,label") || el.querySelector(CLICKABLE)) continue;
        if (!visible(el)) continue;
        listed.push(el);
        known.add(el);
      }
      listed.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      // Past 60, keep the ones in view and in the page's content over the site's menus.
      const OUTSIDE = "nav,aside,header,footer,[role=navigation],[role=banner],[role=complementary],[role=contentinfo]";
      const ranked = listed.map((el, order) => {
        const rect = el.getBoundingClientRect();
        const inView = rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
        const main = !el.closest(OUTSIDE);
        return { el, order, inView, main, rank: (inView ? 2 : 0) + (main ? 1 : 0) };
      });
      const chosen = ranked.length <= 60
        ? ranked
        : [...ranked].sort((a, b) => b.rank - a.rank || a.order - b.order).slice(0, 60).sort((a, b) => a.order - b.order);
      const buttons = chosen.map(({ el, inView, main, rank }, index) => {
        el.setAttribute("data-ravnir-action", String(index));
        return {
          i: index,
          selector: `[data-ravnir-action="${index}"]`,
          tag: el.tagName.toLowerCase(),
          text: label(el),
          // An <a> inside an SVG has an object here, not a string.
          href: typeof el.href === "string" ? el.href : "",
          rank,
          inView,
          main,
        };
      });
      return {
        url: location.href,
        title: document.title,
        text: (document.body?.innerText || "").slice(0, 16000),
        scrollY: window.scrollY,
        scrollHeight: document.documentElement.scrollHeight,
        innerHeight: window.innerHeight,
        fields,
        buttons,
      };
    });
    this.url = result.url || this.url;
    this.title = result.title || "";
    // The note belongs to the site it was about; a click can also land on a block page.
    const here = hostOf(result.url);
    if (this.noticeHost && this.noticeHost !== here) this.#tell("", "");
    if (this.network && !this.notice) {
      const main = this.lastMain && hostOf(this.lastMain.url) === here ? this.lastMain : null;
      const block = detectBlock({ status: main?.status || 0, headers: main?.headers || {}, title: result.title, text: result.text });
      if (block) this.#tell(here, this.network.explain(this.bot, here, block));
    }
    result.notice = this.notice;
    return result;
  }

  async login(entry) {
    if (entry.site && /^https?:/i.test(entry.site)) {
      // Stay on a sign-in form already open on that site; otherwise go to the saved address (often its login page).
      const here = !sameOrigin(this.page.url(), entry.site) ? 0 : await this.page.locator('input[type="password"]').count();
      if (!here) await this.navigate(entry.site);
    }
    const password = this.page.locator('input[type="password"]').first();
    // A sign-in form drawn by a script can take a moment to appear.
    if (!(await password.count())) await password.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
    if (!(await password.count())) {
      const here = this.page.url();
      const asksEmail = await this.page.evaluate(() => [...document.querySelectorAll('input[type=email],input[name*=email i],input[name*=user i],input[autocomplete=username]')]
        .some((el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 1 && rect.height > 1 && style.display !== "none" && style.visibility !== "hidden";
        })).catch(() => false);
      if (asksEmail) {
        throw new Error("No password field on this page: it asks for the email first (it may send a code by email). Type the email with browser_type; the saved password can be filled once a password field shows.");
      }
      // A signed-out page often has no form, only a link to one (a home page with "Log in").
      const signInLink = await this.page.evaluate(() => {
        const words = /\b(log ?in|sign ?in|iniciar sesi[oó]n|inicia sesi[oó]n)\b/i;
        const paths = /(log-?in|sign-?in|signin)/i;
        for (const el of document.querySelectorAll("a,button,[role=button],[role=link]")) {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          if (rect.width <= 1 || rect.height <= 1 || style.display === "none" || style.visibility === "hidden") continue;
          const text = (el.innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
          const href = typeof el.href === "string" ? el.href : "";
          if (words.test(text) || paths.test(href)) return text.slice(0, 60) || "sign in";
        }
        return "";
      }).catch(() => "");
      if (signInLink) {
        throw new Error(`No password field on this page. It has a "${signInLink}" link: click it with browser_click, then call browser_saved_login again.`);
      }
      // Only a redirect from the saved address into the site, away from any sign-in
      // page, shows the browser is still signed in. A missing form alone does not.
      if (entry.site && sameSite(here, entry.site) && redirectedInto(entry.site, here)) {
        await this.refreshMeta();
        return { alreadySignedIn: true, status: this.status(), submitted: false, userFilled: false };
      }
      throw new Error("No password field on this page.");
    }
    const found = await this.page.evaluate(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 1 && rect.height > 1 && style.display !== "none" && style.visibility !== "hidden";
      };
      const pass = [...document.querySelectorAll('input[type="password"]')].find(visible);
      if (!pass) return { ok: false, error: "No password field on this page." };
      const inputs = [...document.querySelectorAll("input")];
      let user = null;
      for (let index = inputs.indexOf(pass) - 1; index >= 0; index -= 1) {
        const type = (inputs[index].type || "text").toLowerCase();
        if (visible(inputs[index]) && ["text", "email", "tel", "username"].includes(type)) {
          user = inputs[index];
          break;
        }
      }
      pass.id = "__ravnir_password";
      if (user) user.id = "__ravnir_username";
      return { ok: true, user: Boolean(user) };
    });
    if (!found?.ok) throw new Error(found?.error || "Could not find a login form.");
    if (found.user) await this.page.locator("#__ravnir_username").fill(entry.username || "");
    await this.page.locator("#__ravnir_password").fill(entry.password || "");
    const submitted = await this.page.evaluate(() => {
      const pass = document.querySelector("#__ravnir_password");
      if (pass?.form) {
        pass.form.requestSubmit();
        return "form";
      }
      const button = [...document.querySelectorAll('button,input[type="submit"],[role="button"]')]
        .find((el) => /sign in|log in|login|continue|submit/i.test((el.innerText || el.value || "").trim()));
      if (button) {
        button.click();
        return "button";
      }
      return "";
    });
    if (!submitted) await this.page.keyboard.press("Enter");
    await this.page.waitForTimeout(1200);
    await this.refreshMeta();
    return { status: this.status(), submitted: Boolean(submitted), userFilled: Boolean(found.user) };
  }

  async #saveState() {
    const now = Date.now();
    if (now - this.lastStateSave < 800) return;
    this.lastStateSave = now;
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify({ url: this.url, title: this.title, at: now }, null, 2));
    } catch {
      // Best effort.
    }
  }

  #clearStaleProfile() {
    if (process.platform === "win32") return;
    try {
      const output = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 2_000_000 });
      for (const line of output.split("\n")) {
        if (!line.includes(this.profile)) continue;
        if (!/Chrome|Chromium|chrome|chromium/.test(line)) continue;
        const pid = Number(line.trim().split(/\s+/)[0]);
        if (!Number.isInteger(pid) || pid === process.pid) continue;
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Ignore.
        }
      }
    } catch {
      // Process inspection is best effort.
    }
    clearForeignLock(this.profile);
  }

  async close() {
    this.closed = true;
    try {
      // For a box browser this only disconnects; Chromium keeps running in the box.
      if (this.cdp) await this.cdp.close();
      else await this.context?.close();
    } catch {
      // Ignore.
    }
    this.cdp = null;
    this.context = null;
    this.page = null;
    this.lastShot = null;
  }
}

let chromiumCache;
let chromiumCheckedAt = 0;

export function findChromium() {
  if (chromiumCache !== undefined && Date.now() - chromiumCheckedAt < 15_000) return chromiumCache;
  chromiumCache = findChromiumUncached();
  chromiumCheckedAt = Date.now();
  return chromiumCache;
}

function findChromiumUncached() {
  if (process.env.RAVNIR_CHROMIUM && executable(process.env.RAVNIR_CHROMIUM)) return process.env.RAVNIR_CHROMIUM;
  try {
    const bundled = chromium.executablePath();
    if (bundled && executable(bundled)) return bundled;
  } catch {
    // Playwright is not installed.
  }
  const candidates = [];
  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    );
  }
  if (process.platform === "linux") {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
    );
  }
  if (process.platform === "win32") {
    candidates.push(
      `${process.env.PROGRAMFILES || "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)"}\\Google\\Chrome\\Application\\chrome.exe`,
    );
  }
  for (const candidate of candidates) {
    if (executable(candidate)) return candidate;
  }
  return "";
}

// A path existing is not enough: another user's browser cache can be listed but
// not executed by the truebot account, which made the Screen panel look broken.
function executable(file) {
  if (!file) return false;
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function systemChrome() {
  try {
    const candidate = chromium.executablePath();
    return candidate && executable(candidate) ? candidate : "";
  } catch {
    return "";
  }
}

export function normalizeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Enter a URL.");
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("That is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.href !== "about:blank") {
    throw new Error("Use an http or https address.");
  }
  return url.href;
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

// The same site, allowing a subdomain either way (app.example.com and example.com).
function sameSite(a, b) {
  try {
    const one = new URL(a).hostname.replace(/^www\./, "");
    const two = new URL(b).hostname.replace(/^www\./, "");
    return one === two || one.endsWith(`.${two}`) || two.endsWith(`.${one}`);
  } catch {
    return false;
  }
}

// The saved address sent the browser to another page that is not a sign-in page.
function redirectedInto(saved, here) {
  try {
    const from = new URL(saved);
    const to = new URL(here);
    const strip = (url) => `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}`;
    if (strip(from) === strip(to)) return false;
    return !/(log-?in|sign-?in|signin|auth|session)/i.test(to.pathname);
  } catch {
    return false;
  }
}

// Chromium's profile lock is a link to "<host>-<pid>". A lock from another host is the
// agent's own computer (a container named after the agent) that ran this profile before
// the agent moved back to the server. Chromium will not take over a profile another
// computer holds: headless it fails, headful it waits on a dialog until the launch times
// out (about 3 minutes per browser step). This launch only runs for an agent on the
// server, so its box browser is not running, and the lock is safe to drop.
export function clearForeignLock(profile, host = os.hostname()) {
  let target = "";
  try {
    target = fs.readlinkSync(path.join(profile, "SingletonLock"));
  } catch {
    return false;
  }
  const owner = target.replace(/-\d+$/, "");
  if (!owner || owner === host) return false;
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    fs.rmSync(path.join(profile, name), { force: true });
  }
  console.warn(`Cleared a browser profile lock left by ${owner} in ${profile}`);
  return true;
}

// The journal keeps Chromium's own words; the agent and the UI get the short form.
function logLaunchError(bot, error) {
  console.warn(`Browser for ${bot?.name || bot?.id || "an agent"} did not start: ${String(error?.message || error).slice(0, 1500)}`);
}

function describeLaunchError(error) {
  const message = error?.message || String(error);
  if (/Executable doesn't exist|not found|ENOENT/i.test(message)) {
    return "Playwright's Chromium is not installed. Run `npx playwright install chromium` on this server.";
  }
  // Playwright's launch errors quote the whole command line, which names the profile
  // folder, so only Chromium's own lock words mean the profile is in use.
  if (/ProcessSingleton|SingletonLock|profile (is|appears to be) in use/i.test(message)) {
    return "The browser profile is locked by another process. Close it and try again.";
  }
  return message.split("\n")[0];
}

function safeName(name) {
  return String(name || "download").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160);
}
