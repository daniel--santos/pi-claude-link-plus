// Shared test helper: locate the extension and launch pi portably.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const EXT = fileURLToPath(new URL("../index.ts", import.meta.url));

/** Windows: `pi` on PATH is an npm .cmd shim, which Node refuses to spawn without a
 *  shell (EINVAL, CVE-2024-27980). Do what the shim does instead: find it on PATH and
 *  run pi's cli.js from the sibling node_modules with the current Node. */
function resolvePiCliWin() {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir || !existsSync(path.join(dir, "pi.cmd"))) continue;
    const cli = path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
    if (existsSync(cli)) return cli;
  }
  return undefined;
}

/** Spawn a pi process with the given args. Honors $PI_CMD ("<node> <cli.js>" or
 *  any launcher) so you can force a compatible Node; else uses `pi` on PATH. */
export function spawnPi(args, opts = {}) {
  const cmd = process.env.PI_CMD;
  if (cmd) {
    const parts = cmd.split(/\s+/).filter(Boolean);
    return spawn(parts[0], [...parts.slice(1), ...args], opts);
  }
  if (process.platform === "win32") {
    const cli = resolvePiCliWin();
    if (!cli) throw new Error("pi not found on PATH (npm i -g @earendil-works/pi-coding-agent) — or set PI_CMD");
    return spawn(process.execPath, [cli, ...args], opts);
  }
  return spawn("pi", args, opts);
}
