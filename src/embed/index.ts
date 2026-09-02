/**
 * Embedding providers. The default runs a small sentence-transformer locally through
 * ONNX so semantic recall works offline, with no API key, on any host.
 * Remote providers are opt-in via environment variables.
 *
 *   LEARNED_EXPERIENCE_EMBEDDINGS = local | openai | ollama | none   (default: local)
 *   LEARNED_EXPERIENCE_EMBED_MODEL = model id for the chosen provider
 *   LEARNED_EXPERIENCE_EMBED_BASE_URL = base URL for openai-compatible / ollama endpoints
 *   LEARNED_EXPERIENCE_EMBED_API_KEY (falls back to OPENAI_API_KEY)
 */

export interface Embedder {
  /** Stable identifier stored with each vector so a model change triggers re-embedding. */
  readonly id: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export type EmbedderKind = "local" | "openai" | "ollama" | "none";

export interface EmbedderConfig {
  kind: EmbedderKind;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  cacheDir?: string;
}

export function embedderConfigFromEnv(env: NodeJS.ProcessEnv, cacheDir: string): EmbedderConfig {
  const kind = (env.LEARNED_EXPERIENCE_EMBEDDINGS ?? "local").toLowerCase() as EmbedderKind;
  if (!["local", "openai", "ollama", "none"].includes(kind)) {
    throw new Error(`LEARNED_EXPERIENCE_EMBEDDINGS must be one of local|openai|ollama|none, got '${kind}'`);
  }
  return {
    kind,
    model: env.LEARNED_EXPERIENCE_EMBED_MODEL,
    baseUrl: env.LEARNED_EXPERIENCE_EMBED_BASE_URL,
    apiKey: env.LEARNED_EXPERIENCE_EMBED_API_KEY ?? env.OPENAI_API_KEY,
    cacheDir,
  };
}

export async function createEmbedder(cfg: EmbedderConfig): Promise<Embedder | null> {
  switch (cfg.kind) {
    case "none":
      return null;
    case "local": {
      const { LocalEmbedder } = await import("./local.js");
      return new LocalEmbedder(cfg.model ?? "Xenova/all-MiniLM-L6-v2", cfg.cacheDir);
    }
    case "openai": {
      const { OpenAiEmbedder } = await import("./remote.js");
      return new OpenAiEmbedder(
        cfg.model ?? "text-embedding-3-small",
        cfg.baseUrl ?? "https://api.openai.com/v1",
        cfg.apiKey
      );
    }
    case "ollama": {
      const { OllamaEmbedder } = await import("./remote.js");
      return new OllamaEmbedder(cfg.model ?? "nomic-embed-text", cfg.baseUrl ?? "http://localhost:11434");
    }
  }
}
