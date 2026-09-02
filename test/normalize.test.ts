import { describe, expect, it } from "vitest";
import { fingerprint, jaccard, normalizeSignal, portablePaths, redact, signalKeys, stem, tokenize } from "../src/normalize.js";

describe("redact", () => {
  it("strips common credential shapes", () => {
    const s = redact("key sk-proj-abcdefghijklmnopqrstuvwxyz012345 and AKIAABCDEFGHIJKLMNOP and ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(s).not.toMatch(/sk-proj/);
    expect(s).not.toMatch(/AKIA/);
    expect(s).not.toMatch(/ghp_/);
    expect(s).toContain("<SECRET>");
  });
  it("strips key=value secrets, emails, bearer tokens and URL creds", () => {
    expect(redact("password=hunter2hunter2")).toBe("password=<SECRET>");
    expect(redact("mail alice@example.com now")).toBe("mail <EMAIL> now");
    expect(redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).toContain("<SECRET>");
    expect(redact("postgres://user:pass@host/db")).toBe("postgres://<CREDS>@host/db");
  });
  it("leaves ordinary text alone", () => {
    const s = "TypeError: Cannot read properties of undefined (reading 'map') at src/app.ts:42";
    expect(redact(s)).toBe(s);
  });
});

describe("portablePaths", () => {
  it("replaces home dirs on all platforms", () => {
    expect(portablePaths("/Users/alice/proj/x.ts /home/alice/y C:\\Users\\alice\\z")).toBe("~/proj/x.ts ~/y ~\\z");
  });
});

describe("normalizeSignal", () => {
  it("collapses volatile tokens so the same error normalises identically", () => {
    const a = normalizeSignal("Error: connect ECONNREFUSED 127.0.0.1:5432 at 0x7ffee3 (pid 4123)");
    const b = normalizeSignal("Error: connect ECONNREFUSED 10.0.0.9:5433 at 0x1a2b3c (pid 77)");
    expect(a).toBe(b);
    expect(a).toBe("error connect econnrefused # # at # pid #");
  });
  it("strips logger prefixes so the same error matches from any tool", () => {
    const bare = normalizeSignal("Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/typescript'");
    expect(normalizeSignal("npm ERR! Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/typescript'")).toBe(bare);
    expect(normalizeSignal("[vite] Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/typescript'")).toBe(bare);
    expect(normalizeSignal("12:04:33 Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/typescript'")).toBe(bare);
  });
  it("treats hashes, uuids and timestamps as volatile", () => {
    const a = normalizeSignal("commit 3fa4c9b12 failed at 2026-09-01T10:00:00Z id 123e4567-e89b-12d3-a456-426614174000");
    expect(a).toBe("commit # failed at # id #");
  });
});

describe("fingerprint", () => {
  it("is stable for the same signals regardless of problem wording", () => {
    const sig = ["ECONNREFUSED 127.0.0.1:5432"];
    expect(fingerprint("db down", sig, ["postgres"])).toBe(fingerprint("cannot connect to database", ["ECONNREFUSED 127.0.0.1:5433"], ["Postgres"]));
  });
  it("differs by context", () => {
    const sig = ["ECONNREFUSED 127.0.0.1:6379"];
    expect(fingerprint("x", sig, ["redis"])).not.toBe(fingerprint("x", sig, ["postgres"]));
  });
  it("falls back to the problem statement without signals", () => {
    expect(fingerprint("Vite HMR not reloading", [], [])).toBe(fingerprint("vite hmr not reloading!", [], []));
    expect(fingerprint("a", [], [])).not.toBe(fingerprint("b", [], []));
  });
  it("signalKeys are per-signal and stable across volatile tokens", () => {
    const a = signalKeys(["ECONNREFUSED 127.0.0.1:5432", "other thing 12"]);
    const b = signalKeys(["ECONNREFUSED 10.0.0.1:5433"]);
    expect(a).toHaveLength(2);
    expect(a).toContain(b[0]);
  });
  it("is order-insensitive for signals and context", () => {
    expect(fingerprint("p", ["a", "b"], ["x", "y"])).toBe(fingerprint("p", ["b", "a"], ["y", "x"]));
  });
});

describe("tokenize / stem / jaccard", () => {
  it("splits identifiers, drops stopwords, stems suffixes", () => {
    expect(tokenize("The connection failed: retrying connections")).toEqual(["connection", "retry", "connection"]);
    expect(tokenize("useEffect cleanup")).toEqual(["use", "effect", "cleanup"]);
  });
  it("stems deterministically", () => {
    expect(stem("migrations")).toBe("migr");
    expect(stem("node")).toBe("node");
  });
  it("jaccard", () => {
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
    expect(jaccard([], [])).toBe(1);
  });
});
