/**
 * node:sqlite emits an ExperimentalWarning on Node 22 while the module graph is linked,
 * which is before any user code runs. The warning is delivered on the next tick through the
 * process 'warning' event, so the default printer is swapped for one that drops just that warning.
 * Everything else still reaches the original listeners.
 */
const original = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (warning: Error) => {
  if (warning.name === "ExperimentalWarning" && /sqlite/i.test(warning.message)) return;
  for (const listener of original) listener.call(process, warning);
});

export {};
