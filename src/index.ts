#!/usr/bin/env node
/**
 * Launcher. The warning filter must be installed before node:sqlite is linked, and static
 * imports are linked before any code runs, so the real entry is loaded dynamically.
 */
import "./quiet.js";
await import("./main.js");
