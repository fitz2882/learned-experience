/** Points git at the versioned hooks in .githooks. Runs from `npm install`; does nothing outside a git checkout. */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

if (existsSync(".git") && !process.env.CI) spawnSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
