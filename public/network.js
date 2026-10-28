// Screen tab: where the agent's browser opens sites from (server/netRoute.js).
// Loaded after app.js, so state, api, toast and reloadBot are global.
// Many sites refuse a server's datacenter network; with a Mac linked, those open
// from the Mac, and the list of such sites is shared by every agent.

(() => {
  const card = document.getElementById("net-card");
  const route = document.getElementById("net-route");
  const proxyForm = document.getElementById("net-proxy");
  const proxyInput = document.getElementById("net-proxy-input");
  const note = document.getElementById("net-state");
  const sites = document.getElementById("net-sites");
  let shownFor = "";

  route.addEventListener("change", async () => {
    if (route.value === "proxy" && !state.network?.proxyHost) {
      // Ask for the address first; the route is saved with it.
      proxyForm.hidden = false;
      proxyInput.focus();
      return;
    }
    await save({ route: route.value });
  });

  proxyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = proxyInput.value.trim();
    if (!value) return proxyInput.focus();
    if (await save({ route: "proxy", proxy: value })) proxyInput.value = "";
  });

  async function save(browser) {
    if (!state.bot) return false;
    try {
      await api(`/api/bots/${state.bot.id}`, { method: "PATCH", body: { browser } });
      await reloadBot();
      document.activeElement?.blur();
      render(state.bot, state.network, { force: true });
      toast("Saved. The browser starts again on its next page.");
      return true;
    } catch (error) {
      toast(error.message, "error");
      render(state.bot, state.network, { force: true });
      return false;
    }
  }

  async function forget(site) {
    try {
      await api(`/api/browser/home-sites/${encodeURIComponent(site)}`, { method: "DELETE" });
      await reloadBot();
      toast(`${site} opens from this server again.`);
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function stateLine(info) {
    if (info.box) return "This agent has its own computer, which opens sites from this server.";
    if (info.route === "proxy") return info.proxyHost ? `Through the proxy at ${info.proxyHost}.` : "Enter the proxy address.";
    if (info.route === "direct") return "Sites that block this server's network stay blocked.";
    if (!info.macLinked) {
      return info.route === "mac"
        ? "No Mac is linked to this server yet, so sites open from here. Link one in Settings, Connections."
        : "Some sites refuse servers. Link a Mac (Settings, Connections) and they open from it.";
    }
    const mac = info.macOnline ? "Your Mac is online." : "Your Mac is offline right now.";
    return info.route === "mac" ? `${mac} Every page this agent opens comes from it.` : `${mac} A site that blocks this server opens from it, for every agent.`;
  }

  function render(bot, info, { force = false } = {}) {
    if (!bot || !info) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    // Leave the controls alone while the user is using them.
    if (!force && card.contains(document.activeElement) && shownFor === bot.id) return;
    shownFor = bot.id;
    route.value = info.route;
    route.disabled = Boolean(info.box);
    proxyForm.hidden = info.route !== "proxy";
    proxyInput.placeholder = info.proxyHost ? `Saved: ${info.proxyHost}. Paste a new address to change it.` : "http://user:password@proxy.example.com:8080";
    note.textContent = stateLine(info);
    const list = info.route === "auto" && info.macLinked ? info.homeSites || [] : [];
    sites.hidden = !list.length;
    sites.replaceChildren();
    if (!list.length) return;
    const label = document.createElement("span");
    label.textContent = "From your Mac:";
    sites.append(label);
    for (const row of list) {
      const chip = document.createElement("span");
      chip.className = "net-site";
      chip.title = row.by ? `${row.site} blocks this server (${row.by})` : row.site;
      const name = document.createElement("span");
      name.textContent = row.site;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Open ${row.site} from this server again`);
      remove.addEventListener("click", () => forget(row.site));
      chip.append(name, remove);
      sites.append(chip);
    }
  }

  window.RavnirNetwork = { render };
})();
