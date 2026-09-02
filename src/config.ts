/**
 * Runtime configuration from the environment. Shared by the MCP server, the CLI and the hook
 * so every entry point reads the same catalogue.
 *
 *   BEEN_THERE_HOME          data directory (default ~/.been-there)
 *   BEEN_THERE_DB            explicit database path (overrides BEEN_THERE_HOME/experiences.db)
 *   BEEN_THERE_TRANSFER_DIR  the only directory the transfer tool may touch (default BEEN_THERE_HOME/transfers)
 *   BEEN_THERE_EMBEDDINGS, BEEN_THERE_EMBED_MODEL, BEEN_THERE_EMBED_BASE_URL, BEEN_THERE_EMBED_API_KEY
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
  const home = env.BEEN_THERE_HOME ?? join(homedir(), ".been-there");
  return {
    home,
    dbPath: env.BEEN_THERE_DB ?? join(home, "experiences.db"),
    transferDir: env.BEEN_THERE_TRANSFER_DIR ?? join(home, "transfers"),
    embedder: embedderConfigFromEnv(env, join(home, "models")),
  };
}

/** Open the catalogue described by a config. Callers own `store.close()`. */
export async function openCatalogue(cfg: Config): Promise<{ store: Store; catalogue: Catalogue; embedderId: string | null }> {
  const store = new Store(cfg.dbPath);
  const embedder = await createEmbedder(cfg.embedder);
  return { store, catalogue: new Catalogue(store, embedder), embedderId: embedder?.id ?? null };
}
