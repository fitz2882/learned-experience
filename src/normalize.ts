/**
 * Deterministic text utilities: redaction, normalisation, tokenisation, fingerprinting.
 * Everything in this module is pure and side-effect free so that the same input
 * always yields the same fingerprint on any machine, for any model.
 */
import { createHash } from "node:crypto";

// ---------- Redaction (secrets must never travel with a record) ----------

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(sk|rk|pk)-(live|test|proj|ant)?-?[A-Za-z0-9_-]{16,}\b/g, "<SECRET>"], // OpenAI / Stripe / Anthropic style
  [/\bAKIA[0-9A-Z]{16}\b/g, "<SECRET>"], // AWS access key id
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "<SECRET>"], // GitHub tokens
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "<SECRET>"], // Slack tokens
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, "<SECRET>"], // Google API keys
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<JWT>"], // JWTs
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "$1 <SECRET>"],
  [/((?:api[_-]?key|token|secret|password|passwd|pwd|authorization)\s*[=:]\s*["']?)[^\s"'&]{6,}/gi, "$1<SECRET>"],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "<EMAIL>"],
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1<CREDS>@"], // credentials embedded in URLs
];

/** Strip credentials and personal identifiers. Deterministic. */
export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

// ---------- Portability (records should not be tied to one machine) ----------

const HOME_PATTERNS: RegExp[] = [
  /\/Users\/[^/\s"']+/g, // macOS
  /\/home\/[^/\s"']+/g, // Linux
  /[A-Za-z]:\\Users\\[^\\\s"']+/g, // Windows
];

/** Replace user home directories with `~` so paths compare equal across machines. */
export function portablePaths(text: string): string {
  let out = text;
  for (const re of HOME_PATTERNS) out = out.replace(re, "~");
  return out;
}

/** Full cleaning pipeline applied to every stored string. */
export function clean(text: string, maxLen: number): string {
  const t = portablePaths(redact(text)).replace(/\s+/g, " ").trim();
  return t.length > maxLen ? t.slice(0, maxLen - 1) + "…" : t;
}

// ---------- Normalisation for fingerprinting ----------

/**
 * Collapse volatile tokens (numbers, hashes, ids, timestamps, memory addresses)
 * so that two occurrences of "the same" error fingerprint identically.
 */
export function normalizeSignal(text: string): string {
  return portablePaths(redact(text))
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "#") // uuid
    .replace(/\b0x[0-9a-f]+\b/g, "#") // hex address
    .replace(/\b[0-9a-f]{7,}\b/g, "#") // hashes / sha
    .replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(:\d{2})?(\.\d+)?z?/g, "#") // timestamps
    .replace(/\b\d+(\.\d+)*\b/g, "#") // numbers / versions / line numbers
    .replace(/[^a-z#~/._\s-]+/g, " ") // punctuation
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeTag(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/[^a-z0-9+#._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Deterministic identity of a problem.
 * When error signals exist they are the stable key (the wording of a summary varies,
 * an error string does not). Context tags disambiguate identical errors in different stacks.
 * Falls back to the normalised problem statement when no signals were given.
 */
export function fingerprint(problem: string, signals: string[], context: string[]): string {
  const sig = uniqueSorted(signals.map(normalizeSignal).filter(Boolean));
  const ctx = uniqueSorted(context.map(normalizeTag).filter(Boolean));
  const key = sig.length > 0 ? `s:${sig.join("\n")}` : `p:${normalizeSignal(problem)}`;
  return sha256(`${key}\nc:${ctx.join(",")}`).slice(0, 32);
}

/**
 * Per-signal exact-match keys. One identical error string is enough for a deterministic hit,
 * even if the record carries other signals the query does not.
 */
export function signalKeys(signals: string[]): string[] {
  return uniqueSorted(signals.map(normalizeSignal).filter(Boolean)).map((s) => sha256(`sig:${s}`).slice(0, 24));
}

/** Key for "the same problem statement, however it was punctuated or numbered". */
export function problemKey(problem: string): string {
  return sha256(`prob:${normalizeSignal(problem)}`).slice(0, 24);
}

export function uniqueSorted(items: string[]): string[] {
  return [...new Set(items)].sort();
}

// ---------- Tokenisation for lexical search ----------

const STOPWORDS = new Set(
  (
    "a an and are as at be but by for from has have if in into is it its of on or that the this to was were will with " +
    "when while which who whom why how not no can do does did i you we they he she my our your their me us them " +
    "error errors fail failed failure failing issue problem"
  ).split(" ")
);

/** Lowercase word tokens with light stemming; camelCase identifiers are split. */
export function tokenize(text: string): string[] {
  const base = portablePaths(text)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
  return base.map(stem);
}

/** Tiny deterministic suffix stemmer. Good enough for error vocabulary, no dictionary needed. */
export function stem(word: string): string {
  if (word.length <= 4) return word;
  const suffixes = ["ations", "ation", "ments", "ment", "ness", "edly", "ing", "ers", "ies", "ied", "er", "ed", "es", "s"];
  for (const s of suffixes) {
    if (word.endsWith(s) && word.length - s.length >= 3) return word.slice(0, -s.length);
  }
  return word;
}

/** Jaccard similarity between token sets. */
export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
