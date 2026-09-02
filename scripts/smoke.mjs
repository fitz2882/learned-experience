import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const t0 = Date.now();
const transport = new StdioClientTransport({
  command: "node",
  args: [process.argv[2]],
  env: { ...process.env, EXPERIENCE_HOME: process.argv[3] },
  stderr: "pipe",
});
transport.stderr?.on("data", (d) => process.stdout.write("  [server] " + d));
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return JSON.parse(r.content[0].text);
};
console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));
console.log("record 1:", await call("record", {
  problem: "Vite dev server does not hot-reload changes inside Docker on macOS",
  signals: ["[vite] hmr update /src/App.tsx (x2)", "changes not reflected in browser"],
  context: ["vite", "docker", "macos"],
  fix: "Set server.watch.usePolling = true in vite.config.ts because Docker Desktop file events do not propagate from the host bind mount",
  avoid: ["Restarting the container", "Clearing the browser cache"],
  root_cause: "inotify events are not forwarded across the macOS bind mount",
  outcome: "success",
  source: { agent: "smoke", model: "none" },
}));
console.log("record 2:", await call("record", {
  problem: "Prisma migrate fails against Supabase because of shadow database permissions",
  signals: ["Error: P3014 Prisma Migrate could not create the shadow database"],
  context: ["prisma", "postgres", "supabase"],
  fix: "Set shadowDatabaseUrl to a separate database the role can create, or use prisma db push for hosted Postgres",
  outcome: "success",
}));
const t1 = Date.now();
const sem = await call("recall", { problem: "file changes not picked up by the bundler when running in a container", context: ["docker"] });
console.log(`semantic recall (${Date.now() - t1}ms):`, JSON.stringify(sem, null, 1));
const exact = await call("recall", { problem: "prisma migration error", signals: ["Error: P3014 Prisma Migrate could not create the shadow database"] });
console.log("exact recall:", exact.hits.map((h) => [h.id, h.match]));
console.log("reinforce:", await call("reinforce", { id: sem.hits[0].id, worked: true }));
console.log("stats:", await call("stats"));
console.log(`total ${Date.now() - t0}ms`);
await client.close();
