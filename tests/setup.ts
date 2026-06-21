/**
 * Shared test setup
 *
 * Loads .env, provides helpers for all tests.
 * Run: node --import ./tests/setup.ts --test tests/*.test.ts
 */

import fs from "fs";
import path from "path";

const envPath = path.resolve(import.meta.dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

process.env.NODE_ENV ??= "test";
process.env.PORT ??= "3000";
process.env.JWT_SECRET ??= "test-secret-key";
process.env.BYPASS_OTP ??= "true";
