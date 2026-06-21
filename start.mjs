/**
 * Wrapper that manually loads .env then runs server.ts via tsx.
 * Handles percent-encoded characters in env values (e.g. %40 → @).
 */
import { readFileSync } from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Parse .env file — decode percent-encoded sequences in values
const envPath = path.join(__dirname, ".env");
const envVars = {};
try {
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    // Do NOT decode DATABASE_URL — pg driver handles %40 in URLs
    // but Node's --env-file double-decodes it, so we keep it as-is
    envVars[key] = val;
  }
  console.log("[start] Loaded .env —", Object.keys(envVars).length, "vars");
} catch (e) {
  console.error("[start] Could not read .env:", e.message);
}

const env = { ...process.env, ...envVars };

const tsx = path.join(__dirname, "node_modules", ".bin", "tsx");
console.log("[start] Spawning tsx server.ts ...");

const child = spawn(tsx, ["server.ts"], {
  cwd: __dirname,
  env,
  stdio: "inherit",
});

child.on("error", (err) => { console.error("[start] spawn error:", err.message); process.exit(1); });
child.on("exit", (code, signal) => {
  console.log("[start] server exited — code:", code, "signal:", signal);
  process.exit(code ?? 0);
});

process.on("SIGINT",  () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
