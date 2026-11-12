/** Local CI: the checks a change must pass before it is pushed. `npm run ci`; run by the pre-push hook. */
import { spawnSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const steps = [
  ["privacy", process.execPath, ["scripts/privacy-check.mjs"]],
  ["typecheck", npm, ["run", "-s", "typecheck"]],
  ["unit tests", npm, ["test", "--silent"]],
  ["build", npm, ["run", "-s", "build"]],
  ["smoke (stdio server)", process.execPath, ["scripts/smoke.mjs", "dist/index.js", ".learned-experience"]],
  ["quality (real model)", process.execPath, ["scripts/quality.mjs"]],
];
const skip = new Set((process.env.LE_CI_SKIP ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const started = Date.now();
for (const [name, cmd, args] of steps) {
  if (skip.has(name.split(" ")[0])) {
    console.log(`- ${name}: skipped`);
    continue;
  }
  const t = Date.now();
  const r = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", shell: process.platform === "win32" });
  const secs = ((Date.now() - t) / 1000).toFixed(1);
  if (r.status !== 0) {
    process.stdout.write(r.stdout ?? "");
    process.stderr.write(r.stderr ?? "");
    console.error(`✗ ${name} failed after ${secs}s`);
    process.exit(1);
  }
  console.log(`✓ ${name} (${secs}s)`);
}
console.log(`local CI passed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
