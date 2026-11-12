/**
 * Fails when tracked files or unpushed commit messages contain personal details.
 * Built-in checks: real-looking email addresses and home-folder paths with a real user name.
 * Private terms (names, project or folder names) go in `.privacy-patterns`, one regex per line.
 * That file is git-ignored so the terms themselves never reach the public repository.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20 });
const SAFE_USERS = new Set(["alice", "bob", "x", "u", "user", "me", "you", "name", "runner", "someone"]);
const SAFE_EMAIL = /(@example\.(com|org|net)|noreply)/i;
const SKIP = /(^|\/)(package-lock\.json|.*\.(png|jpg|jpeg|gif|ico|webp|woff2?))$/;

const rules = [
  { name: "email address", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, ok: (m) => SAFE_EMAIL.test(m) },
  {
    name: "home folder of a real user",
    re: /(?:\/Users\/|\/home\/|[A-Z]:\\{1,2}Users\\{1,2})([A-Za-z0-9._-]+)/g,
    ok: (_m, user) => SAFE_USERS.has(user.toLowerCase()),
  },
];
const privateFile = ".privacy-patterns";
if (existsSync(privateFile))
  for (const line of readFileSync(privateFile, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith("#")) rules.push({ name: "private term", re: new RegExp(t, "gi"), ok: () => false });
  }

const findings = [];
function scan(label, text) {
  text.split(/\r?\n/).forEach((line, i) => {
    for (const r of rules)
      for (const m of line.matchAll(r.re)) if (!r.ok(m[0], m[1] ?? "")) findings.push(`${label}:${i + 1}  ${r.name}: ${m[0]}`);
  });
}

for (const file of git("ls-files", "-z").split("\0").filter(Boolean)) {
  if (SKIP.test(file) || !existsSync(file)) continue;
  scan(file, readFileSync(file, "utf8"));
}
let base = "";
try {
  base = git("merge-base", "HEAD", "origin/main").trim();
} catch {}
if (base) for (const sha of git("rev-list", `${base}..HEAD`).split("\n").filter(Boolean)) scan(`commit ${sha.slice(0, 7)}`, git("log", "-1", "--format=%an <%ae>%n%B", sha));

if (findings.length) {
  console.error(`privacy check failed (${findings.length}):\n  ` + findings.join("\n  "));
  console.error(`\nUse placeholders such as /Users/alice or alice@example.com. Private terms live in ${privateFile} (git-ignored).`);
  process.exit(1);
}
console.log(`privacy check passed (${rules.length} rules${existsSync(privateFile) ? ", including private terms" : ""})`);
