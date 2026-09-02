/**
 * `learned-experience install`: detect the agent hosts on this machine and register the MCP server
 * plus whatever hooks each host supports. Idempotent, backs up every file it changes, never removes
 * anything that is not ours, and `--dry-run` reports without writing.
 *
 * Hosts and what can be automated:
 *   claude-code     MCP via `claude mcp add`; hooks in ~/.claude/settings.json (skipped when the plugin is installed)
 *   codex           MCP via `codex mcp add` (or config.toml); hooks in ~/.codex/hooks.json; trust step is manual
 *   gemini          MCP + hooks in ~/.gemini/settings.json
 *   cursor          MCP in ~/.cursor/mcp.json (no hooks; rules snippet is manual)
 *   windsurf        MCP in ~/.codeium/windsurf/mcp_config.json (no hooks)
 *   claude-desktop  MCP in the platform config file (no hooks)
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";

export type HostId = "claude-code" | "codex" | "gemini" | "openclaw" | "cursor" | "windsurf" | "claude-desktop";
export const ALL_HOSTS: HostId[] = ["claude-code", "codex", "gemini", "openclaw", "cursor", "windsurf", "claude-desktop"];

export interface Launch {
  command: string;
  args: string[];
}

export interface Exec {
  (command: string, args: string[]): { ok: boolean; output: string };
}

export interface InstallOptions {
  home: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  hosts?: HostId[];
  dryRun?: boolean;
  uninstall?: boolean;
  /** How hosts should launch the server. Default: npx -y learned-experience. */
  launch?: Launch;
  /** Test seam for running host CLIs. */
  exec?: Exec;
  /** Test seam for CLI presence. */
  hasCli?: (name: string) => boolean;
}

export interface HostReport {
  host: HostId;
  name: string;
  detected: boolean;
  changes: string[];
  manual: string[];
  note?: string;
}

const SERVER = "learned-experience";
const HOOK_CMD = "learned-experience hook";
const NPX_LAUNCH: Launch = { command: "npx", args: ["-y", "learned-experience"] };

interface HookSpec {
  event: string;
  timeout: number;
  name?: boolean;
  statusMessage?: string;
}

const CLAUDE_HOOKS: HookSpec[] = [
  { event: "PostToolUseFailure", timeout: 30 },
  { event: "UserPromptSubmit", timeout: 20 },
  { event: "Stop", timeout: 20 },
];
const CODEX_HOOKS: HookSpec[] = [
  { event: "PostToolUse", timeout: 30, statusMessage: "learned-experience: checking past experience" },
  { event: "UserPromptSubmit", timeout: 20 },
  { event: "Stop", timeout: 20 },
];
const GEMINI_HOOKS: HookSpec[] = [
  { event: "AfterTool", timeout: 30000, name: true },
  { event: "BeforeAgent", timeout: 20000, name: true },
];

// ---------------------------------------------------------------- helpers

function defaultExec(command: string, args: string[]): { ok: boolean; output: string } {
  const r = spawnSync(command, args, { encoding: "utf8", timeout: 60_000 });
  return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function defaultHasCli(name: string): boolean {
  const r = spawnSync(name, ["--version"], { encoding: "utf8", timeout: 15_000 });
  return !r.error && r.status === 0;
}

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8").trim();
  if (!text) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object`);
  return parsed as Record<string, unknown>;
}

class Writer {
  private backedUp = new Set<string>();
  constructor(private readonly dryRun: boolean) {}

  writeJson(file: string, data: Record<string, unknown>): void {
    if (this.dryRun) return;
    if (existsSync(file) && !this.backedUp.has(file)) {
      copyFileSync(file, `${file}.bak`);
      this.backedUp.add(file);
    }
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
  }

  writeText(file: string, text: string): void {
    if (this.dryRun) return;
    if (existsSync(file) && !this.backedUp.has(file)) {
      copyFileSync(file, `${file}.bak`);
      this.backedUp.add(file);
    }
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text, "utf8");
  }
}

/** Register or remove our server in a `{ "mcpServers": { ... } }` JSON file. Returns a change description or null. */
function mergeMcpJson(file: string, launch: Launch, uninstall: boolean, w: Writer): string | null {
  const data = readJson(file);
  const servers = (data.mcpServers && typeof data.mcpServers === "object" ? data.mcpServers : {}) as Record<string, unknown>;
  const desired = { command: launch.command, args: launch.args };
  if (uninstall) {
    if (!(SERVER in servers)) return null;
    delete servers[SERVER];
    data.mcpServers = servers;
    w.writeJson(file, data);
    return `removed MCP server from ${file}`;
  }
  if (JSON.stringify(servers[SERVER]) === JSON.stringify(desired)) return null;
  const existed = SERVER in servers;
  servers[SERVER] = desired;
  data.mcpServers = servers;
  w.writeJson(file, data);
  return `${existed ? "updated" : "added"} MCP server in ${file}`;
}

function hookCommand(launch: Launch): string {
  return [launch.command, ...launch.args, "hook"].map((p) => (/\s/.test(p) ? JSON.stringify(p) : p)).join(" ");
}

function isOurs(entry: unknown): boolean {
  const hooks = (entry as { hooks?: unknown })?.hooks;
  return Array.isArray(hooks) && hooks.some((h) => typeof (h as { command?: unknown })?.command === "string" && (h as { command: string }).command.includes(HOOK_CMD));
}

/** Add or remove our hook entries in a `{ "hooks": { Event: [ { hooks: [...] } ] } }` structure. */
function mergeHooks(data: Record<string, unknown>, specs: HookSpec[], launch: Launch, uninstall: boolean): string[] {
  const hooks = (data.hooks && typeof data.hooks === "object" ? data.hooks : {}) as Record<string, unknown>;
  const changes: string[] = [];
  for (const spec of specs) {
    const list = (Array.isArray(hooks[spec.event]) ? hooks[spec.event] : []) as unknown[];
    const mineIdx = list.findIndex(isOurs);
    if (uninstall) {
      if (mineIdx >= 0) {
        list.splice(mineIdx, 1);
        changes.push(`removed ${spec.event} hook`);
      }
    } else {
      const h: Record<string, unknown> = { type: "command", command: hookCommand(launch), timeout: spec.timeout };
      if (spec.name) h.name = SERVER;
      if (spec.statusMessage) h.statusMessage = spec.statusMessage;
      const entry = { hooks: [h] };
      if (mineIdx < 0) {
        list.push(entry);
        changes.push(`added ${spec.event} hook`);
      } else if (JSON.stringify(list[mineIdx]) !== JSON.stringify(entry)) {
        list[mineIdx] = entry;
        changes.push(`updated ${spec.event} hook`);
      }
    }
    if (list.length > 0) hooks[spec.event] = list;
    else delete hooks[spec.event];
  }
  if (Object.keys(hooks).length > 0) data.hooks = hooks;
  else delete data.hooks;
  return changes;
}

// ------------------------------------------------------------------ hosts

function claudeDesktopConfig(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return join(home, ".config", "Claude", "claude_desktop_config.json");
}

export function installHosts(opts: InstallOptions): HostReport[] {
  const home = opts.home;
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const dryRun = opts.dryRun ?? false;
  const uninstall = opts.uninstall ?? false;
  const launch = opts.launch ?? NPX_LAUNCH;
  const exec = opts.exec ?? defaultExec;
  const hasCli = opts.hasCli ?? defaultHasCli;
  const w = new Writer(dryRun);
  const wanted = new Set(opts.hosts ?? ALL_HOSTS);
  const reports: HostReport[] = [];
  const launchArgs = [launch.command, ...launch.args];

  // ---- Claude Code
  if (wanted.has("claude-code")) {
    const dir = join(home, ".claude");
    const r: HostReport = { host: "claude-code", name: "Claude Code", detected: existsSync(dir) || hasCli("claude"), changes: [], manual: [] };
    if (r.detected) {
      const pluginInstalled = existsSync(join(dir, "plugins", "cache", SERVER));
      if (pluginInstalled && !uninstall) {
        r.note = "the learned-experience plugin is installed and already provides the server and hooks";
      } else {
        if (hasCli("claude")) {
          const has = exec("claude", ["mcp", "get", SERVER]).ok;
          if (uninstall && has) {
            if (!dryRun) exec("claude", ["mcp", "remove", "--scope", "user", SERVER]);
            r.changes.push("removed MCP server via `claude mcp remove`");
          } else if (!uninstall && !has) {
            if (!dryRun) {
              const res = exec("claude", ["mcp", "add", "--scope", "user", SERVER, "--", ...launchArgs]);
              if (!res.ok) throw new Error(`claude mcp add failed: ${res.output}`);
            }
            r.changes.push("registered MCP server via `claude mcp add --scope user`");
          }
        } else {
          r.manual.push(`register the server: claude mcp add --scope user ${SERVER} -- ${launchArgs.join(" ")}`);
        }
        const settings = join(dir, "settings.json");
        const data = readJson(settings);
        const changes = mergeHooks(data, CLAUDE_HOOKS, launch, uninstall);
        if (changes.length) {
          w.writeJson(settings, data);
          r.changes.push(...changes.map((c) => `${c} in ${settings}`));
        }
        if (!uninstall) r.manual.push("restart Claude Code");
      }
    }
    reports.push(r);
  }

  // ---- Codex
  if (wanted.has("codex")) {
    const dir = join(home, ".codex");
    const r: HostReport = { host: "codex", name: "Codex CLI", detected: existsSync(dir) || hasCli("codex"), changes: [], manual: [] };
    if (r.detected) {
      const configToml = join(dir, "config.toml");
      if (hasCli("codex")) {
        const has = exec("codex", ["mcp", "get", SERVER]).ok;
        if (uninstall && has) {
          if (!dryRun) exec("codex", ["mcp", "remove", SERVER]);
          r.changes.push("removed MCP server via `codex mcp remove`");
        } else if (!uninstall && !has) {
          if (!dryRun) {
            const res = exec("codex", ["mcp", "add", SERVER, "--", ...launchArgs]);
            if (!res.ok) throw new Error(`codex mcp add failed: ${res.output}`);
          }
          r.changes.push("registered MCP server via `codex mcp add`");
        }
      } else {
        const text = existsSync(configToml) ? readFileSync(configToml, "utf8") : "";
        const header = `[mcp_servers.${SERVER}]`;
        if (!uninstall && !text.includes(header)) {
          const block = `\n${header}\ncommand = ${JSON.stringify(launch.command)}\nargs = ${JSON.stringify(launch.args)}\n`;
          w.writeText(configToml, text.replace(/\s*$/, "\n") + block);
          r.changes.push(`added MCP server to ${configToml}`);
        } else if (uninstall && text.includes(header)) {
          r.manual.push(`remove the ${header} block from ${configToml}`);
        }
      }
      const hooksFile = join(dir, "hooks.json");
      const data = readJson(hooksFile);
      const changes = mergeHooks(data, CODEX_HOOKS, launch, uninstall);
      if (changes.length) {
        if (!data.description && !uninstall) data.description = "Hooks for learned-experience";
        w.writeJson(hooksFile, data);
        r.changes.push(...changes.map((c) => `${c} in ${hooksFile}`));
      }
      if (!uninstall) r.manual.push("in Codex, run /hooks once to review and trust the learned-experience hooks");
    }
    reports.push(r);
  }

  // ---- Gemini CLI
  if (wanted.has("gemini")) {
    const dir = join(home, ".gemini");
    const r: HostReport = { host: "gemini", name: "Gemini CLI", detected: existsSync(dir) || hasCli("gemini"), changes: [], manual: [] };
    if (r.detected) {
      const settings = join(dir, "settings.json");
      const data = readJson(settings);
      const servers = (data.mcpServers && typeof data.mcpServers === "object" ? data.mcpServers : {}) as Record<string, unknown>;
      const desired = { command: launch.command, args: launch.args };
      let touched = false;
      if (uninstall) {
        if (SERVER in servers) {
          delete servers[SERVER];
          touched = true;
          r.changes.push(`removed MCP server from ${settings}`);
        }
      } else if (JSON.stringify(servers[SERVER]) !== JSON.stringify(desired)) {
        r.changes.push(`${SERVER in servers ? "updated" : "added"} MCP server in ${settings}`);
        servers[SERVER] = desired;
        touched = true;
      }
      if (Object.keys(servers).length > 0 || data.mcpServers) data.mcpServers = servers;
      const changes = mergeHooks(data, GEMINI_HOOKS, launch, uninstall);
      if (changes.length) {
        touched = true;
        r.changes.push(...changes.map((c) => `${c} in ${settings}`));
      }
      if (touched) w.writeJson(settings, data);
    }
    reports.push(r);
  }

  // ---- OpenClaw: MCP under mcp.servers in ~/.openclaw/openclaw.json (JSON5; edited only when it is plain JSON)
  if (wanted.has("openclaw")) {
    const dir = join(home, ".openclaw");
    const file = join(dir, "openclaw.json");
    const r: HostReport = { host: "openclaw", name: "OpenClaw", detected: existsSync(dir) || hasCli("openclaw"), changes: [], manual: [] };
    if (r.detected) {
      let data: Record<string, unknown> | null = null;
      try {
        data = readJson(file);
      } catch {
        data = null; // JSON5 with comments or trailing commas: do not risk rewriting it
      }
      const desired = { command: launch.command, args: launch.args, transport: "stdio", enabled: true };
      if (data) {
        const mcp = (data.mcp && typeof data.mcp === "object" ? data.mcp : {}) as Record<string, unknown>;
        const servers = (mcp.servers && typeof mcp.servers === "object" ? mcp.servers : {}) as Record<string, unknown>;
        if (uninstall) {
          if (SERVER in servers) {
            delete servers[SERVER];
            mcp.servers = servers;
            data.mcp = mcp;
            w.writeJson(file, data);
            r.changes.push(`removed MCP server from ${file}`);
          }
        } else if (JSON.stringify(servers[SERVER]) !== JSON.stringify(desired)) {
          r.changes.push(`${SERVER in servers ? "updated" : "added"} MCP server in ${file}`);
          servers[SERVER] = desired;
          mcp.servers = servers;
          data.mcp = mcp;
          w.writeJson(file, data);
        }
      } else if (hasCli("openclaw")) {
        if (!uninstall) {
          if (!dryRun) {
            const res = exec("openclaw", ["mcp", "add", SERVER, "--command", launch.command, ...launch.args.flatMap((a) => ["--arg", a]), "--no-probe"]);
            if (!res.ok) throw new Error(`openclaw mcp add failed: ${res.output}`);
          }
          r.changes.push("registered MCP server via `openclaw mcp add`");
        } else {
          if (!dryRun) exec("openclaw", ["mcp", "unset", SERVER]);
          r.changes.push("removed MCP server via `openclaw mcp unset`");
        }
      } else {
        r.manual.push(`${file} uses JSON5 syntax; add the server with: openclaw mcp add ${SERVER} --command ${launch.command} ${launch.args.map((a) => `--arg ${a}`).join(" ")}`);
      }
      if (!uninstall) r.manual.push("restart the OpenClaw gateway; hooks are not available, the model follows the protocol from MCP instructions");
    }
    reports.push(r);
  }

  // ---- Cursor, Windsurf, Claude Desktop: MCP only
  const mcpOnly: Array<{ id: HostId; name: string; dir: string; file: string; manual: string[] }> = [
    {
      id: "cursor",
      name: "Cursor",
      dir: join(home, ".cursor"),
      file: join(home, ".cursor", "mcp.json"),
      manual: ["Cursor has no hooks: add the two-line reminder from the README to your Cursor rules"],
    },
    {
      id: "windsurf",
      name: "Windsurf",
      dir: join(home, ".codeium", "windsurf"),
      file: join(home, ".codeium", "windsurf", "mcp_config.json"),
      manual: ["Windsurf has no hooks: add the two-line reminder from the README to your global rules"],
    },
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      dir: join(claudeDesktopConfig(home, platform, env), ".."),
      file: claudeDesktopConfig(home, platform, env),
      manual: ["restart Claude Desktop"],
    },
  ];
  for (const h of mcpOnly) {
    if (!wanted.has(h.id)) continue;
    const r: HostReport = { host: h.id, name: h.name, detected: existsSync(h.dir), changes: [], manual: [] };
    if (r.detected) {
      const change = mergeMcpJson(h.file, launch, uninstall, w);
      if (change) r.changes.push(change);
      if (!uninstall) r.manual.push(...h.manual);
    }
    reports.push(r);
  }

  return reports;
}

export function formatReport(reports: HostReport[], dryRun: boolean, uninstall: boolean): string {
  const lines: string[] = [];
  const verb = uninstall ? "uninstall" : "install";
  lines.push(dryRun ? `learned-experience ${verb} (dry run: nothing written)` : `learned-experience ${verb}`);
  for (const r of reports) {
    if (!r.detected) {
      lines.push(`  ${r.name}: not found`);
      continue;
    }
    if (r.note) {
      lines.push(`  ${r.name}: ${r.note}`);
      continue;
    }
    lines.push(`  ${r.name}:` + (r.changes.length === 0 ? " already up to date" : ""));
    for (const c of r.changes) {
      const future = c.replace(/^(added|updated|removed|registered)\b/, (v) => `would ${v.replace(/ed$/, "").replace(/^regist$/, "register").replace(/^remov$/, "remove").replace(/^updat$/, "update")}`);
      lines.push(`    ${dryRun ? future : c}`);
    }
    for (const m of r.manual) lines.push(`    next: ${m}`);
  }
  return lines.join("\n") + "\n";
}
