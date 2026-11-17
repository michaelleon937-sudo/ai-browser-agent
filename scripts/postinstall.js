import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Cloudflare Workers Builds runs as a restricted build user. Browser binaries
// are not needed for this pre-bundled Worker, so skip only in Workers Builds.
if (process.env.WORKERS_CI === "1") {
  console.log("[postinstall] Skipping Playwright browser installation in Cloudflare Workers Builds.");
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const playwrightCli = resolve(root, "node_modules", "playwright", "cli.js");
const result = spawnSync(process.execPath, [playwrightCli, "install", "--with-deps", "chromium"], { stdio: "inherit" });
process.exit(result.status ?? 1);
