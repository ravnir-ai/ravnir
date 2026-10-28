// The environment of a program Ravnir starts that runs code or content it does
// not control: MCP connectors and plugins, the browser and the desktop, ai-memory,
// git, the 1Password CLI. It gets what it needs to find itself and run, and
// nothing else from the server's environment, which on a server holds the sign-in
// password, the Mac link token and API keys (for example /etc/ravnir/ravnir.env). Each caller
// adds the few variables its program needs. A bot's own shell is stricter still,
// see commandEnv in computer.js.
export const PASS_THROUGH = [
  // Where programs and the user's files are.
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR",
  // Language and time.
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TERM", "TZ",
  // Per-user folders. Rootless podman finds its socket and storage through XDG_RUNTIME_DIR
  // (a systemd service needs it set), so container plugins need it.
  "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "DBUS_SESSION_BUS_ADDRESS",
  // Where a container runtime listens when it is not the default one.
  "DOCKER_HOST", "DOCKER_CONTEXT", "CONTAINER_HOST", "CONTAINER_CONNECTION",
  // Where Playwright keeps its browsers (for example /opt/ravnir/.playwright), for connectors
  // that drive a browser of their own.
  "PLAYWRIGHT_BROWSERS_PATH",
  // Extra certificate authorities, for servers behind a TLS-inspecting proxy.
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  // Windows cannot start a program without these.
  "SYSTEMROOT", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
];

export function childEnv(extra = {}, source = process.env) {
  const env = {};
  for (const key of PASS_THROUGH) if (source[key]) env[key] = source[key];
  for (const [key, value] of Object.entries(extra || {})) {
    if (value !== undefined && value !== null) env[key] = String(value);
  }
  return env;
}
