import type { Catalogue } from "./catalogue.js";
import type { Store } from "./store.js";

/** Local-only worker; no model calls and no lesson-provided commands. Stop hooks never start it. */
export function startMaintenanceWorker(
  catalogue: Catalogue,
  store: Store,
  options: {
    intervalMs?: number;
    onError?: (error: unknown) => void;
    keepAlive?: boolean;
  } = {},
) {
  const interval = Math.max(100, options.intervalMs ?? 300_000);
  let busy = false,
    stopped = false;
  const tick = async () => {
    if (busy || stopped) return;
    // All MCP hosts sharing this database cooperate on one interval lease.
    const acquired = store.transaction(() => {
      const last = Number(store.getMeta("maintenance:last-run") ?? 0);
      if (Date.now() - last < interval) return false;
      store.setMeta("maintenance:last-run", String(Date.now()));
      return true;
    });
    if (!acquired) return;
    busy = true;
    try {
      await catalogue.maintain(20, 100);
    } catch (error) {
      options.onError?.(error);
    } finally {
      busy = false;
    }
  };
  const safeTick = () => {
    void tick().catch((error) => options.onError?.(error));
  };
  const timer = setInterval(safeTick, interval);
  if (!options.keepAlive) timer.unref();
  safeTick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
