import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { Catalogue } from "../src/catalogue.js";
import { buildServer } from "../src/server.js";
import { Store } from "../src/store.js";
import { FakeEmbedder } from "./fake-embedder.js";

async function connect() {
  const catalogue = new Catalogue(new Store(":memory:"), new FakeEmbedder());
  const server = buildServer(catalogue, { transferDir: "/nonexistent/transfers" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test-host", version: "0.0.0" });
  await client.connect(clientT);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* error text */
    }
    return { isError: res.isError === true, text, json };
  };
}

describe("lenient record and feedback input", () => {
  it("trims long text and maps scope aliases instead of rejecting the call", async () => {
    const call = await connect();
    const rec = await call("record", {
      problem: "SwiftUI slider ignores date values in XCTest ".repeat(10),
      signals: Array.from({ length: 12 }, (_, i) => `XCTAssertEqual failed case ${i}`),
      fix: "Drive the slider with an explicit coordinate drag. ".repeat(30),
      avoid: ["Normalized adjust(toNormalizedSliderPosition:) " + "x".repeat(400)],
      outcome: "success",
      applicability: { os: "ios", framework: "swiftui", simulator: "iPhone 17" },
      source: { agent: "Codex independent construction-trial auditor with a very long subagent label" },
    });
    expect(rec.isError).toBe(false);
    const { json: lesson } = await call("inspect", { id: rec.json.id });
    const doc = lesson.lesson ?? lesson.record ?? lesson;
    expect(doc.problem.length).toBeLessThanOrEqual(240);
    expect(doc.fix.length).toBeLessThanOrEqual(600);
    expect(doc.signals).toHaveLength(8);
    expect(doc.applicability).toEqual({ platform: "ios", product: "swiftui" });
    expect(doc.preconditions).toEqual(["simulator: iPhone 17"]);

    const attempt = await call("begin_attempt", { id: rec.json.id, execution_id: "ci-run-42", environment: { platform: "ios", product: "swiftui" } });
    expect(attempt.isError).toBe(false);
    const fb = await call("feedback", {
      ...attempt.json,
      result: "verified-success",
      environment: { os: "ios", framework: "swiftui" },
      evidence: { summary: "UI test passes", reference: "ci-run-42", observed_at: "2026-01-02", level: "local-test" },
    });
    expect(fb.isError).toBe(false);
  });
});
