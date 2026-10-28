#!/usr/bin/env node
import "../server/env.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BackupError, exportArchive, restoreArchive } from "../server/backup.js";
import { SecretStore } from "../server/secrets.js";

// Export or restore a Ravnir data folder from the command line, with the server stopped.
//   node bin/backup.mjs export [out.tar.gz] [--workspaces]
//   node bin/backup.mjs restore <backup.tar.gz> [--force]
// The passphrase for secrets comes from RAVNIR_BACKUP_PASSPHRASE (empty exports without secrets).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.RAVNIR_HOME || path.join(root, "data");
const vaultDir = process.env.RAVNIR_VAULT_DIR || (process.env.RAVNIR_VAULT === "local" ? path.join(home, "vault") : "");
const [command, target, ...rest] = process.argv.slice(2);
const passphrase = process.env.RAVNIR_BACKUP_PASSPHRASE || "";

try {
  if (command === "export") {
    const archive = await exportArchive({ home, secrets: passphrase ? new SecretStore(home) : null, vaultDir, passphrase, workspaces: rest.includes("--workspaces") || target === "--workspaces" });
    const out = path.resolve(target && !target.startsWith("--") ? target : archive.name);
    fs.copyFileSync(archive.file, out);
    archive.cleanup();
    console.log(`Saved ${out}: ${archive.manifest.bots.length} agents, vault ${archive.manifest.vault || "none"}, secrets ${archive.manifest.secrets}.`);
  } else if (command === "restore" && target) {
    const result = await restoreArchive({ file: path.resolve(target), home, passphrase, secrets: new SecretStore(home), vaultDir, force: rest.includes("--force") });
    console.log(`Restored ${result.bots} agents into ${home}; secrets ${result.secrets ? "restored" : "not in the backup"}; vault ${result.vault}. Start Ravnir.`);
  } else {
    console.error("Usage: node bin/backup.mjs export [out.tar.gz] [--workspaces] | restore <backup.tar.gz> [--force]");
    process.exit(2);
  }
} catch (error) {
  console.error(error instanceof BackupError ? error.message : error.stack || error.message);
  process.exit(1);
}
