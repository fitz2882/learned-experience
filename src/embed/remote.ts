/**
 * Remote embedding providers. Any OpenAI-compatible endpoint works with OpenAiEmbedder
 * (OpenAI, Azure, Voyage-compatible proxies, LM Studio, vLLM). Ollama has its own shape.
 */
import type { Embedder } from "./index.js";

export class OpenAiEmbedder implements Embedder {
  readonly id: string;

  constructor(
    private readonly model: string,
    private readonly baseUrl: string,
    private readonly apiKey?: string
  ) {
    this.id = `openai:${model}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) throw new Error(`embedding request failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> };
    return json.data.sort((a, b) => a.index - b.index).map((d) => Float32Array.from(d.embedding));
  }
}

export class OllamaEmbedder implements Embedder {
  readonly id: string;

  constructor(
    private readonly model: string,
    private readonly baseUrl: string
  ) {
    this.id = `ollama:${model}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) throw new Error(`ollama embed failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { embeddings: number[][] };
    return json.embeddings.map((e) => Float32Array.from(e));
  }
}
