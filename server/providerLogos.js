// Provider logos from models.dev, downloaded by scripts/build-provider-logos.mjs into
// public/plugins/providers and served by the plugin asset route (no script can run in them).
import fs from "node:fs";

const INDEX = new URL("../public/plugins/providers/index.json", import.meta.url);
let ids = null;

export function providerLogo(id) {
  if (!ids) {
    try {
      ids = new Set(JSON.parse(fs.readFileSync(INDEX, "utf8")));
    } catch {
      ids = new Set();
    }
  }
  return ids.has(String(id)) ? `/plugins/providers/${id}.svg` : "";
}

// The logo for an agent's model: OpenCode ids are "provider/model".
export function modelLogo(model = {}) {
  const id = String(model.model || "");
  if (model.provider !== "opencode" || !id.includes("/")) return "";
  return providerLogo(id.slice(0, id.indexOf("/")));
}
