/**
 * Deterministic hashed bag-of-words embedder for tests. No model download,
 * but similar texts still produce similar vectors, so dedup and semantic ranking can be exercised.
 */
import { createHash } from "node:crypto";
import type { Embedder } from "../src/embed/index.js";
import { tokenize } from "../src/normalize.js";

export class FakeEmbedder implements Embedder {
  readonly id = "fake:hashed-bow-64";
  calls = 0;

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls++;
    return texts.map((t) => {
      const v = new Float32Array(64);
      for (const tok of tokenize(t)) {
        const h = createHash("md5").update(tok).digest();
        v[h[0] % 64] += 1;
        v[h[1] % 64] += 0.5;
      }
      let n = 0;
      for (const x of v) n += x * x;
      n = Math.sqrt(n) || 1;
      for (let i = 0; i < v.length; i++) v[i] /= n;
      return v;
    });
  }
}
