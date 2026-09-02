/**
 * In-memory BM25 index. Pure TypeScript, deterministic, no native dependencies.
 * Catalogue sizes for this use case are thousands of records, not millions,
 * so brute-force scoring is more than fast enough.
 */
import { tokenize } from "../normalize.js";

export interface Bm25Hit {
  id: string;
  score: number;
}

export class Bm25Index {
  private readonly k1: number;
  private readonly b: number;
  private docs = new Map<string, Map<string, number>>(); // id -> term -> tf
  private lengths = new Map<string, number>();
  private df = new Map<string, number>();
  private totalLen = 0;

  constructor(k1 = 1.2, b = 0.75) {
    this.k1 = k1;
    this.b = b;
  }

  get size(): number {
    return this.docs.size;
  }

  add(id: string, text: string): void {
    if (this.docs.has(id)) this.remove(id);
    const tokens = tokenize(text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.docs.set(id, tf);
    this.lengths.set(id, tokens.length);
    this.totalLen += tokens.length;
  }

  remove(id: string): void {
    const tf = this.docs.get(id);
    if (!tf) return;
    for (const t of tf.keys()) {
      const d = (this.df.get(t) ?? 1) - 1;
      if (d <= 0) this.df.delete(t);
      else this.df.set(t, d);
    }
    this.totalLen -= this.lengths.get(id) ?? 0;
    this.docs.delete(id);
    this.lengths.delete(id);
  }

  /** Hits with raw BM25 scores, sorted desc then by id for determinism. */
  search(query: string, limit = 20): Bm25Hit[] {
    const qTerms = [...new Set(tokenize(query))];
    if (qTerms.length === 0 || this.docs.size === 0) return [];
    const N = this.docs.size;
    const avgLen = this.totalLen / N || 1;
    const hits: Bm25Hit[] = [];
    for (const [id, tf] of this.docs) {
      let score = 0;
      const len = this.lengths.get(id) ?? 0;
      for (const term of qTerms) {
        const f = tf.get(term);
        if (!f) continue;
        const n = this.df.get(term) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * len) / avgLen)));
      }
      if (score > 0) hits.push({ id, score });
    }
    hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return hits.slice(0, limit);
  }
}
