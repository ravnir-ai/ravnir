#!/usr/bin/env node
// Starts one of a bot's stdio MCP connectors for OpenCode with the environment Ravnir gives the
// connectors it starts itself (server/childEnv.js). OpenCode hands its whole environment to the
// programs it starts, and on the hub that includes the password of its own server.
//
//   connector-env.mjs [--keep NAME]... -- command [args...]
//
// Each --keep NAME is one of the connector's own variables. OpenCode supplies the value through
// `environment` in the bot's opencode.json; only the name is on the command line, because every
// user on the machine can read a process's arguments in /proc/<pid>/cmdline.
import { spawn } from "node:child_process";
import os from "node:os";
import { childEnv } from "../server/childEnv.js";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function fail(message, code = 2) {
  process.stderr.write(`connector-env: ${message}\n`);
  process.exit(code);
}

const argv = process.argv.slice(2);
const keep = [];
let index = 0;
while (index < argv.length && argv[index] !== "--") {
  if (argv[index] !== "--keep" || !NAME.test(argv[index + 1] || "")) fail(`unexpected argument ${argv[index]}`);
  keep.push(argv[index + 1]);
  index += 2;
}
const [command, ...args] = argv.slice(index + 1);
if (!command) fail("usage: connector-env.mjs [--keep NAME]... -- command [args...]");

const own = {};
for (const name of keep) if (process.env[name] !== undefined) own[name] = process.env[name];

const child = spawn(command, args, { env: childEnv(own), stdio: "inherit" });
// OpenCode stops a connector with a signal to this process; pass it on so the connector shuts down too.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}
child.on("error", (error) => fail(`could not start ${command}: ${error.message}`, 127));
child.on("exit", (code, signal) => {
  if (!signal) process.exit(code ?? 1);
  // End the same way the connector did, so OpenCode sees the signal and not a plain exit code.
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
  setTimeout(() => process.exit(128 + (os.constants.signals[signal] || 0)), 1000);
});
