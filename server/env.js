// Settings come from RAVNIR_* variables. Servers set up while the project was called TrueBot
// still have TRUEBOT_* names, so each one is copied to its new name unless that is already set.
// Entry points import this first, before any module reads its settings.

export function adoptLegacyEnv(env = process.env) {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("TRUEBOT_")) continue;
    const name = `RAVNIR_${key.slice("TRUEBOT_".length)}`;
    if (env[name] === undefined) env[name] = value;
  }
  return env;
}

adoptLegacyEnv();
