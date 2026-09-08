import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatReport, installHosts, type HostReport } from "../src/install.js";

function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "le-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".gemini"), { recursive: true });
  mkdirSync(join(home, ".openclaw"), { recursive: true });
  mkdirSync(join(home, ".cursor"), { recursive: true });
  mkdirSync(join(home, "Library", "Application Support", "Claude"), { recursive: true });
  return home;
}

const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const byHost = (r: HostReport[], id: string) => r.find((x) => x.host === id)!;

describe("installHosts", () => {
  it("registers server and hooks on every detected host, without CLIs, and is idempotent", () => {
    const home = fakeHome();
    // Pre-existing config that must survive.
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "echo bye" }] }] } }));
    writeFileSync(join(home, ".codex", "hooks.json"), JSON.stringify({ description: "mine", hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "start.sh" }] }] } }));
    writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n');
    writeFileSync(join(home, ".gemini", "settings.json"), JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } }));
    writeFileSync(join(home, ".openclaw", "openclaw.json"), JSON.stringify({ agents: { defaults: {} }, mcp: { servers: { other: { command: "x", transport: "stdio" } } } }));

    const opts = { home, platform: "darwin" as const, env: {}, hasCli: () => false, exec: () => ({ ok: false, output: "" }) };
    const first = installHosts(opts);
    expect(first.map((r) => [r.host, r.detected])).toEqual([
      ["claude-code", true],
      ["codex", true],
      ["gemini", true],
      ["openclaw", true],
      ["cursor", true],
      ["windsurf", false],
      ["claude-desktop", true],
    ]);

    // Claude Code: hooks merged, existing Stop hook kept, MCP registration left as a manual step (no CLI).
    const claude = json(join(home, ".claude", "settings.json"));
    expect(claude.permissions.allow).toEqual(["Bash(ls)"]);
    expect(claude.hooks.Stop).toHaveLength(2);
    expect(claude.hooks.Stop[0].hooks[0].command).toBe("echo bye");
    expect(claude.hooks.PostToolUseFailure[0].hooks[0]).toEqual({ type: "command", command: "npx -y learned-experience hook", timeout: 30 });
    expect(claude.hooks.PostToolUse[0].hooks[0]).toEqual({ type: "command", command: "npx -y learned-experience hook", timeout: 30 });
    expect(claude.hooks.UserPromptSubmit[0].hooks[0].command).toBe("npx -y learned-experience hook");
    expect(byHost(first, "claude-code").manual[0]).toMatch(/claude mcp add --scope user learned-experience -- npx -y learned-experience/);
    expect(existsSync(join(home, ".claude", "settings.json.bak"))).toBe(true);

    // Codex: TOML block appended, hooks merged with the existing SessionStart kept, trust step manual.
    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(toml).toContain('[mcp_servers.other]\ncommand = "x"');
    expect(toml).toContain('[mcp_servers.learned-experience]\ncommand = "npx"\nargs = ["-y","learned-experience"]');
    const codex = json(join(home, ".codex", "hooks.json"));
    expect(codex.description).toBe("mine");
    expect(codex.hooks.SessionStart[0].hooks[0].command).toBe("start.sh");
    expect(codex.hooks.PostToolUse[0].hooks[0]).toMatchObject({ command: "npx -y learned-experience hook --codex", timeout: 30 });
    expect(codex.hooks.Stop).toHaveLength(1);
    expect(byHost(first, "codex").manual.some((m) => /\/hooks/.test(m))).toBe(true);

    // Gemini: server and hooks in settings.json, theme preserved, timeouts in milliseconds with a name.
    const gemini = json(join(home, ".gemini", "settings.json"));
    expect(gemini.theme).toBe("dark");
    expect(gemini.mcpServers.other).toEqual({ command: "x" });
    expect(gemini.mcpServers["learned-experience"]).toEqual({ command: "npx", args: ["-y", "learned-experience"] });
    expect(gemini.hooks.AfterTool[0].hooks[0]).toEqual({ type: "command", command: "npx -y learned-experience hook", timeout: 30000, name: "learned-experience" });
    expect(gemini.hooks.BeforeAgent[0].hooks[0].timeout).toBe(20000);

    // OpenClaw: mcp.servers entry with transport and enabled, other servers and sections preserved.
    const openclaw = json(join(home, ".openclaw", "openclaw.json"));
    expect(openclaw.agents).toEqual({ defaults: {} });
    expect(openclaw.mcp.servers.other).toEqual({ command: "x", transport: "stdio" });
    expect(openclaw.mcp.servers["learned-experience"]).toEqual({ command: "npx", args: ["-y", "learned-experience"], transport: "stdio", enabled: true });
    expect(byHost(first, "openclaw").manual.some((m) => /gateway/.test(m))).toBe(true);

    // Cursor and Claude Desktop: MCP only.
    expect(json(join(home, ".cursor", "mcp.json")).mcpServers["learned-experience"].command).toBe("npx");
    expect(json(join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")).mcpServers["learned-experience"].args).toEqual(["-y", "learned-experience"]);

    // Second run changes nothing.
    const second = installHosts(opts);
    for (const r of second) expect(r.changes).toEqual([]);
    expect(json(join(home, ".claude", "settings.json")).hooks.Stop).toHaveLength(2);
  });

  it("uses host CLIs when present and skips Claude Code when the plugin is installed", () => {
    const home = fakeHome();
    mkdirSync(join(home, ".claude", "plugins", "cache", "learned-experience"), { recursive: true });
    const calls: string[] = [];
    const exec = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args].join(" "));
      return { ok: args[1] === "add" || args[1] === "remove", output: "" }; // `get` fails => not registered yet
    };
    const reports = installHosts({ home, hosts: ["claude-code", "codex"], hasCli: () => true, exec });
    expect(byHost(reports, "claude-code").note).toMatch(/plugin is installed/);
    expect(calls).toEqual(["codex mcp get learned-experience", "codex mcp add learned-experience -- npx -y learned-experience"]);
    expect(byHost(reports, "codex").changes[0]).toMatch(/codex mcp add/);
  });

  it("dry run reports without writing", () => {
    const home = fakeHome();
    const reports = installHosts({ home, dryRun: true, hasCli: () => false, exec: () => ({ ok: false, output: "" }) });
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    expect(byHost(reports, "cursor").changes[0]).toMatch(/added MCP server/);
    const text = formatReport(reports, true, false);
    expect(text).toContain("dry run");
    expect(text).toContain("would add MCP server");
    expect(text).not.toContain("would added");
    expect(text).toContain("Windsurf: not found");
  });

  it("uninstall removes only our entries", () => {
    const home = fakeHome();
    writeFileSync(join(home, ".gemini", "settings.json"), JSON.stringify({ mcpServers: { other: { command: "x" } }, hooks: { AfterTool: [{ hooks: [{ type: "command", command: "theirs.sh" }] }] } }));
    const opts = { home, hasCli: () => false, exec: () => ({ ok: false, output: "" }) };
    installHosts(opts);
    const reports = installHosts({ ...opts, uninstall: true });
    const gemini = json(join(home, ".gemini", "settings.json"));
    expect(gemini.mcpServers).toEqual({ other: { command: "x" } });
    expect(gemini.hooks.AfterTool).toHaveLength(1);
    expect(gemini.hooks.AfterTool[0].hooks[0].command).toBe("theirs.sh");
    expect(gemini.hooks.BeforeAgent).toBeUndefined();
    expect(json(join(home, ".cursor", "mcp.json")).mcpServers).toEqual({});
    expect(json(join(home, ".claude", "settings.json")).hooks).toBeUndefined();
    expect(byHost(reports, "gemini").changes.length).toBeGreaterThan(0);
  });

  it("leaves a JSON5 OpenClaw config alone and falls back to the CLI or a manual step", () => {
    const home = fakeHome();
    writeFileSync(join(home, ".openclaw", "openclaw.json"), "// comment\n{ mcp: { servers: {} }, }\n");
    const noCli = installHosts({ home, hosts: ["openclaw"], hasCli: () => false, exec: () => ({ ok: false, output: "" }) });
    expect(readFileSync(join(home, ".openclaw", "openclaw.json"), "utf8")).toContain("// comment");
    expect(byHost(noCli, "openclaw").changes).toEqual([]);
    expect(byHost(noCli, "openclaw").manual[0]).toMatch(/openclaw mcp add learned-experience --command npx --arg -y --arg learned-experience/);
    const calls: string[] = [];
    const withCli = installHosts({ home, hosts: ["openclaw"], hasCli: () => true, exec: (c, a) => (calls.push([c, ...a].join(" ")), { ok: true, output: "" }) });
    expect(calls).toEqual(["openclaw mcp add learned-experience --command npx --arg -y --arg learned-experience --no-probe"]);
    expect(byHost(withCli, "openclaw").changes[0]).toMatch(/openclaw mcp add/);
  });

  it("supports a local launch command with spaces quoted in hook commands", () => {
    const home = fakeHome();
    installHosts({ home, hosts: ["gemini"], hasCli: () => false, launch: { command: "/usr/local/bin/node", args: ["/Users/alice/my proj/dist/index.js"] } });
    const gemini = json(join(home, ".gemini", "settings.json"));
    expect(gemini.mcpServers["learned-experience"]).toEqual({ command: "/usr/local/bin/node", args: ["/Users/alice/my proj/dist/index.js"] });
    expect(gemini.hooks.AfterTool[0].hooks[0].command).toBe('/usr/local/bin/node "/Users/alice/my proj/dist/index.js" hook');
  });
});
