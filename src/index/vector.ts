/**
 * In-memory cosine-similarity index over unit-normalised Float32 vectors.
 * Brute force is deliberate: deterministic, dependency-free, and fast at catalogue scale.
 */
export interface VectorHit {
  id: string;
  score: number; // cosine similarity in [-1, 1]
}

export class VectorIndex {
  private vectors = new Map<string, Float32Array>();

  get size(): number {
    return this.vectors.size;
  }

  add(id: string, vector: Float32Array): void {
    this.vectors.set(id, normalize(vector));
  }

  remove(id: string): void {
    this.vectors.delete(id);
  }

  has(id: string): boolean {
    return this.vectors.has(id);
  }

  get(id: string): Float32Array | undefined {
    return this.vectors.get(id);
  }

  search(query: Float32Array, limit = 20): VectorHit[] {
    const q = normalize(query);
    const hits: VectorHit[] = [];
    for (const [id, v] of this.vectors) {
      if (v.length !== q.length) continue;
      hits.push({ id, score: dot(q, v) });
    }
    hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return hits.slice(0, limit);
  }

  /** All pairs at or above a threshold, in deterministic id order. Used by consolidation. */
  similarPairs(threshold: number): Array<[string, string, number]> {
    const ids = [...this.vectors.keys()].sort();
    const out: Array<[string, string, number]> = [];
    for (let i = 0; i < ids.length; i++) {
      const a = this.vectors.get(ids[i])!;
      for (let j = i + 1; j < ids.length; j++) {
        const b = this.vectors.get(ids[j])!;
        if (a.length !== b.length) continue;
        const s = dot(a, b);
        if (s >= threshold) out.push([ids[i], ids[j], s]);
      }
    }
    return out;
  }
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n === 0 || Math.abs(n - 1) < 1e-6) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}
