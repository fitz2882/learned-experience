/**
 * Local ONNX sentence embeddings via @huggingface/transformers.
 * First use downloads the model (~23 MB for all-MiniLM-L6-v2) into the cache dir;
 * after that it runs fully offline. Same model + same input = same vector.
 */
import type { Embedder } from "./index.js";

type Extractor = (texts: string[], opts: { pooling: "mean"; normalize: boolean }) => Promise<{
  data: Float32Array;
  dims: number[];
}>;

export class LocalEmbedder implements Embedder {
  readonly id: string;
  private extractor: Promise<Extractor> | null = null;

  constructor(
    private readonly model: string,
    private readonly cacheDir?: string
  ) {
    this.id = `local:${model}`;
  }

  private async load(): Promise<Extractor> {
    if (!this.extractor) {
      this.extractor = (async () => {
        const tf = await import("@huggingface/transformers");
        if (this.cacheDir) tf.env.cacheDir = this.cacheDir;
        const pipe = await tf.pipeline("feature-extraction", this.model, { dtype: "q8" });
        return pipe as unknown as Extractor;
      })();
    }
    return this.extractor;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const extractor = await this.load();
    const out = await extractor(texts, { pooling: "mean", normalize: true });
    const [n, dim] = out.dims;
    const vectors: Float32Array[] = [];
    for (let i = 0; i < n; i++) vectors.push(new Float32Array(out.data.slice(i * dim, (i + 1) * dim)));
    return vectors;
  }
}
