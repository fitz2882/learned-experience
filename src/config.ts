/**
 * Runtime configuration from the environment. Shared by the MCP server, the CLI and the hook
 * so every entry point reads the same catalogue.
 *
 *   LEARNED_EXPERIENCE_HOME          data directory (default ~/.learned-experience)
 *   LEARNED_EXPERIENCE_DB            explicit database path (overrides LEARNED_EXPERIENCE_HOME/experiences.db)
 *   LEARNED_EXPERIENCE_TRANSFER_DIR  the only directory the transfer tool may touch (default LEARNED_EXPERIENCE_HOME/transfers)
 *   LEARNED_EXPERIENCE_EMBEDDINGS, LEARNED_EXPERIENCE_EMBED_MODEL, LEARNED_EXPERIENCE_EMBED_BASE_URL, LEARNED_EXPERIENCE_EMBED_API_KEY
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { Catalogue } from "./catalogue.js";
import { createEmbedder, embedderConfigFromEnv, type EmbedderConfig } from "./embed/index.js";
import { Store } from "./store.js";

export interface Config {
  home: string;
  dbPath: string;
  transferDir: string;
  embedder: EmbedderConfig;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const home = env.LEARNED_EXPERIENCE_HOME ?? join(homedir(), ".learned-experience");
  return {
    home,
    dbPath: env.LEARNED_EXPERIENCE_DB ?? join(home, "experiences.db"),
    transferDir: env.LEARNED_EXPERIENCE_TRANSFER_DIR ?? join(home, "transfers"),
    embedder: embedderConfigFromEnv(env, join(home, "models")),
  };
}

/** Open the catalogue described by a config. Callers own `store.close()`. */
export async function openCatalogue(cfg: Config): Promise<{ store: Store; catalogue: Catalogue; embedderId: string | null }> {
  const store = new Store(cfg.dbPath);
  const embedder = await createEmbedder(cfg.embedder);
  return { store, catalogue: new Catalogue(store, embedder), embedderId: embedder?.id ?? null };
}
