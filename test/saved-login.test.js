import assert from "node:assert/strict";
import test from "node:test";
import { callBuiltinTool } from "../server/computer.js";
import { withBrowser } from "./fixtures/browser-site.js";

// Seen in a replay: the saved address (/splash) sent a signed-in browser straight into
// the app, so there was no password field, and the agent was told its saved login was
// rejected and to ask the user.
test("a saved login on a site the browser is already signed in to reports that, not a failure", async (t) => {
  await withBrowser(t, {
    "/splash": { status: 302, headers: { location: "/home" } },
    "/home": "<title>Home</title><p>Hi, Sam. Your campaigns are below.</p>",
    "/signin": "<title>Sign in</title><p>Sign in to continue.</p>",
    "/start": `<title>Start</title><form><label>Email <input type="email" name="email"></label><button>Next</button></form>`,
    // Signed out: a home page with only a link to the sign-in form.
    "/": `<title>Shop</title><header><a href="/account/login">Log in</a></header><p>New arrivals.</p>`,
    "/shop": { status: 302, headers: { location: "/shop/en" } },
    "/shop/en": `<title>Shop</title><button>Sign in</button><p>New arrivals.</p>`,
    "/dashboard": "<title>Dashboard</title><p>Welcome back.</p>",
  }, async ({ base, bot, ctx }) => {
    const sign = async (site) => {
      bot.vault = [{ id: "l1", site, username: "sam@test" }];
      return callBuiltinTool("browser_saved_login", { site }, { ...ctx, passwordFor: async () => "pw" });
    };
    const done = await sign(`${base}/splash`);
    assert.match(done.text, /^Already signed in to http:\/\/127\.0\.0\.1:\d+\/splash: it opened Home at .*\/home with no sign-in form\. Nothing was typed\.$/);
    assert.equal(bot.vault[0].lastUsedAt, undefined);

    // A sign-in page that asks for the email first says so.
    await assert.rejects(sign(`${base}/start`), /asks for the email first/);
    // A sign-in page with no form at all is still an error.
    await assert.rejects(sign(`${base}/signin`), /^Error: No password field on this page\.$/);
    // A signed-out home page is not "already signed in", with or without a redirect.
    await assert.rejects(sign(`${base}/`), /^Error: No password field on this page\. It has a "Log in" link: click it with browser_click/);
    await assert.rejects(sign(`${base}/shop`), /It has a "Sign in" link/);
    // No redirect and no form: nothing shows a session, so it stays an error.
    await assert.rejects(sign(`${base}/dashboard`), /^Error: No password field on this page\.$/);
  });
});
