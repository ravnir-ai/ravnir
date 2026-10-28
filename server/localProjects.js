import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Project folders on this same machine that the owner wants agents to read directly, from
// RAVNIR_LOCAL_PROJECTS: "shop=/srv/shop;blog=/srv/blog" (a bare path takes its folder name).
// Agents that run on the host get them in their prompt, so they read them with their own
// terminal instead of reaching the same machine through ssh. Nothing is scanned on its own.
export const MAX_LOCAL_PROJECTS = 12;

export function localProjects({ env = process.env } = {}) {
  const value = String(env.RAVNIR_LOCAL_PROJECTS || "").trim();
  if (!value || value.toLowerCase() === "off") return [];
  const out = [];
  for (const item of value.split(";")) {
    const text = item.trim();
    if (!text) continue;
    const cut = text.indexOf("=");
    const dir = (cut === -1 ? text : text.slice(cut + 1)).trim();
    if (!path.isAbsolute(dir)) continue;
    const name = (cut === -1 ? path.basename(dir) : text.slice(0, cut)).trim().replace(/[\u0000-\u001f]/g, "").slice(0, 40);
    if (!name || !readableDir(dir) || out.some((entry) => entry.path === dir)) continue;
    out.push({ name, path: dir });
    if (out.length >= MAX_LOCAL_PROJECTS) break;
  }
  return out;
}

export function localHostName() {
  return os.hostname();
}

function readableDir(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    fs.accessSync(dir, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
