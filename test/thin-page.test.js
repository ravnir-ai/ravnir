import assert from "node:assert/strict";
import test from "node:test";
import { fetchPageWithFallback } from "../server/web.js";
import { withBrowser } from "./fixtures/browser-site.js";

// Seen in a replay: a job page that loads its content with a script read as just its
// title, so the agent could not confirm the job was open.
test("a page that loads its content with a script is read after the content arrives", async (t) => {
  await withBrowser(t, {
    "/job": `<title>Careers</title><div id="app"></div>
      <script>setTimeout(() => fetch("/data").then((r) => r.text()).then((t) => { document.getElementById("app").textContent = t; }), 200)</script>`,
    "/data": { delay: 300, headers: { "content-type": "text/plain" }, body: "Job open. ".repeat(40) },
  }, async ({ base, session }) => {
    await session.navigate(`${base}/job`);
    const page = await session.read();
    assert.match(page.text, /Job open\./);
  });
});

// web_fetch of a short page must not move the agent's own tab: a half-filled form there
// would be lost, and the next browser tool would act on the fetched page.
test("web_fetch renders a thin page in a scratch tab and leaves the agent's page alone", async (t) => {
  await withBrowser(t, {
    "/form": `<title>Booking</title><form><label>Name <input name="name"></label></form>`,
    "/short": `<title>Terms</title><div id="app"></div>
      <script>document.getElementById("app").innerHTML = "<p>" + "These terms apply. ".repeat(20) + "</p><a href='/terms/full'>Full terms</a>"</script>`,
  }, async ({ base, browser, bot, session }) => {
    await session.navigate(`${base}/form`);
    await session.typeSelector('input[name="name"]', "Sam");
    const thin = async (url) => ({ url, status: 200, title: "Terms", text: "Terms" });
    const page = await fetchPageWithFallback(`${base}/short`, { browser, bot, fetchPage: thin });
    assert.equal(session.page.url(), `${base}/form`);
    assert.equal(await session.page.inputValue('input[name="name"]'), "Sam");
    assert.equal(session.context.pages().length, 1);
    assert.equal(page.via, "browser");
    assert.match(page.text, /These terms apply\./);
    assert.match(page.text, /Links on this page:\n- Full terms: http:\/\/127\.0\.0\.1:\d+\/terms\/full/);
  });
});
