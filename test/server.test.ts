import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { Catalogue } from "../src/catalogue.js";
import { buildServer, PROTOCOL, resolveTransferPath } from "../src/server.js";
import { Store } from "../src/store.js";
import { FakeEmbedder } from "./fake-embedder.js";

async function connect(transferDir = "/nonexistent/transfers") {
  const catalogue = new Catalogue(new Store(":memory:"), new FakeEmbedder());
  const server = buildServer(catalogue, { transferDir });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test-host", version: "0.0.0" });
  await client.connect(clientT);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    return { isError: res.isError === true, text, json: safeJson(text) };
  };
  return { client, call };
}

function safeJson(t: string): any {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

describe("MCP surface", () => {
  it("advertises the protocol, tools, resource and prompt", async () => {
    const { client } = await connect();
    expect(client.getInstructions()).toBe(PROTOCOL);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["amend", "consolidate", "forget", "recall", "record", "reinforce", "stats", "transfer"]);
    const recall = (await client.listTools()).tools.find((t) => t.name === "recall")!;
    expect(recall.annotations?.readOnlyHint).toBe(true);
    expect((await client.listResources()).resources.map((r) => r.uri)).toEqual(["learned-experience://protocol"]);
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(["solve"]);
    const res = await client.readResource({ uri: "learned-experience://protocol" });
    expect((res.contents[0] as { text: string }).text).toContain("TRIGGER");
  });

  it("runs the full loop over the wire: record -> recall -> reinforce -> stats", async () => {
    const { call } = await connect();
    const rec = await call("record", {
      problem: "npm install fails with EACCES on global prefix",
      signals: ["EACCES: permission denied, mkdir '/usr/local/lib/node_modules/foo'"],
      context: ["npm", "macos"],
      fix: "Set a user-owned prefix: npm config set prefix ~/.npm-global and add it to PATH",
      avoid: ["sudo npm install -g"],
      outcome: "success",
      source: { agent: "test-host", model: "fake" },
    });
    expect(rec.isError).toBe(false);
    expect(rec.json.action).toBe("created");

    const hit = await call("recall", {
      problem: "global npm install permission error",
      signals: ["EACCES: permission denied, mkdir '/usr/local/lib/node_modules/foo'"],
      context: ["npm"],
    });
    expect(hit.json.hits).toHaveLength(1);
    expect(hit.json.hits[0].match.exact).toBe(true);
    expect(hit.json.hits[0].avoid).toContain("sudo npm install -g");

    const rf = await call("reinforce", { id: rec.json.id, worked: true });
    expect(rf.json.confidence).toBeCloseTo(2 / 3);

    const st = await call("stats");
    expect(st.json.records).toBe(1);
    expect(st.json.total_successes).toBe(1);
  });

  it("validates input and reports errors as tool errors, not protocol errors", async () => {
    const { call } = await connect();
    const invalid = await call("record", { problem: "x", outcome: "success" }); // schema rejects problem < 3 chars
    expect(invalid.isError).toBe(true);
    expect(invalid.text).toMatch(/validation/i);
    const rf = await call("reinforce", { id: "x_missing", worked: true });
    expect(rf.isError).toBe(true);
    expect(rf.text).toMatch(/no experience/);
  });

  it("confines transfer paths to the transfer directory and .jsonl files", async () => {
    expect(resolveTransferPath("backup.jsonl", "/data/t")).toBe("/data/t/backup.jsonl");
    expect(resolveTransferPath("sub/backup.jsonl", "/data/t")).toBe("/data/t/sub/backup.jsonl");
    expect(() => resolveTransferPath("../etc/passwd.jsonl", "/data/t")).toThrow(/inside the transfer directory/);
    expect(() => resolveTransferPath("/etc/passwd", "/data/t")).toThrow(/inside the transfer directory/);
    expect(() => resolveTransferPath("notes.txt", "/data/t")).toThrow(/\.jsonl/);

    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "exp-transfer-"));
    const { call } = await connect(dir);
    await call("record", { problem: "Xcode archive fails with missing provisioning profile", context: ["xcode"], fix: "Download profiles in Xcode settings", outcome: "success" });
    const exported = await call("transfer", { mode: "export", path: "nested/backup.jsonl" });
    expect(exported.json.path).toBe(join(dir, "nested", "backup.jsonl"));
    expect(exported.json.records).toBe(1);
    const escaped = await call("transfer", { mode: "export", path: "../escape.jsonl" });
    expect(escaped.isError).toBe(true);
    const reimport = await call("transfer", { mode: "import", path: "nested/backup.jsonl" });
    expect(reimport.json.skipped).toBe(1);
  });

  it("transfers inline JSONL", async () => {
    const a = await connect();
    await a.call("record", { problem: "Docker build hangs on apt-get update", context: ["docker"], fix: "Add --no-cache and pin the mirror", outcome: "success" });
    const exported = await a.call("transfer", { mode: "export" });
    expect(exported.text.split("\n")).toHaveLength(1);
    const b = await connect();
    const imported = await b.call("transfer", { mode: "import", jsonl: exported.text });
    expect(imported.json.inserted).toBe(1);
    const hit = await b.call("recall", { problem: "docker apt-get update hanging during build" });
    expect(hit.json.hits[0].fix).toContain("--no-cache");
  });
});
