import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const client = new Client({ name: "http-smoke", version: "0.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3199/mcp")));
console.log("tools:", (await client.listTools()).tools.length);
const r = await client.callTool({ name: "recall", arguments: { problem: "vite not reloading in docker", context: ["docker"] } });
const j = JSON.parse(r.content[0].text);
console.log("http recall hits:", j.hits.map((h) => [h.id, h.match.score, h.match.via]));
await client.close();
