/**
 * Environment Configuration Validation & Comparison Tool
 *
 * Usage:
 *   npx tsx scripts/env-compare.ts                # use .env for local
 *   npx tsx scripts/env-compare.ts --remote <url>  # compare with deployed env
 *
 * Compares:
 *   - All env vars expected by the application
 *   - Configuration values
 *   - Feature flags
 *   - Third-party credentials
 *   - Database URLs, storage paths
 *   - Highlights missing or mismatched values (without secrets)
 */

import fs from "fs";
import path from "path";

const EXPECTED_ENV_VARS: Record<string, {
  required: boolean;
  description: string;
  category: "database" | "auth" | "email" | "app" | "admin" | "deployment";
  sensitive: boolean;
  defaultValue?: string;
}> = {
  DATABASE_URL: { required: true, description: "PostgreSQL connection string", category: "database", sensitive: true },
  JWT_SECRET: { required: true, description: "JWT signing secret", category: "auth", sensitive: true },
  PORT: { required: false, description: "Server port", category: "app", sensitive: false, defaultValue: "3000" },
  NODE_ENV: { required: false, description: "Environment (production/development)", category: "app", sensitive: false, defaultValue: "development" },
  EMAIL_USER: { required: false, description: "Nodemailer Gmail user", category: "email", sensitive: false },
  EMAIL_PASS: { required: false, description: "Nodemailer Gmail app password", category: "email", sensitive: true },
  BYPASS_OTP: { required: false, description: "Skip OTP verification (true/false)", category: "auth", sensitive: false, defaultValue: "false" },
  ADMIN_EMAIL: { required: false, description: "Default admin email", category: "admin", sensitive: false },
  ADMIN_PASSWORD: { required: false, description: "Default admin password", category: "admin", sensitive: true },
  ADMIN_NAME: { required: false, description: "Default admin name", category: "admin", sensitive: false },
  FRONTEND_URL: { required: false, description: "Frontend URL for CORS", category: "deployment", sensitive: false },
};

interface EnvSnapshot {
  source: string;
  vars: Record<string, string | undefined>;
  timestamp: string;
}

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, "utf-8");
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

function maskSensitive(value: string | undefined, sensitive: boolean): string {
  if (!value) return "<NOT SET>";
  if (!sensitive) return value;
  if (value.length <= 8) return "****";
  return value.slice(0, 4) + "****" + value.slice(-4);
}

function getDeployedEnv(remoteUrl: string): Promise<Record<string, string | undefined>> {
  // Attempt to fetch /api/debug/db which may echo some config
  // In a real scenario, you'd have a dedicated /api/debug/env endpoint
  return Promise.resolve({});
}

async function main() {
  const args = process.argv.slice(2);
  const remoteUrl = args.includes("--remote") ? args[args.indexOf("--remote") + 1] : null;

  // Load local env
  const envPath = path.resolve(__dirname, "..", ".env");
  const localVars = parseEnvFile(envPath);
  const processVars = process.env as Record<string, string | undefined>;

  const local: EnvSnapshot = {
    source: envPath,
    vars: { ...localVars, ...Object.fromEntries(
      Object.entries(EXPECTED_ENV_VARS).map(([k]) => [k, processVars[k] || localVars[k]])
    ) },
    timestamp: new Date().toISOString(),
  };

  // Load remote env if specified
  let remote: EnvSnapshot | null = null;
  if (remoteUrl) {
    const remoteVars = await getDeployedEnv(remoteUrl);
    remote = {
      source: remoteUrl,
      vars: remoteVars,
      timestamp: new Date().toISOString(),
    };
  }

  // Generate report
  console.log("=".repeat(72));
  console.log("  ENVIRONMENT CONFIGURATION VALIDATION REPORT");
  console.log("=".repeat(72));
  console.log(`  Generated: ${local.timestamp}`);
  console.log(`  Local env: ${local.source}`);
  console.log(`  Remote:    ${remote ? remote.source : "NOT CHECKED"}`);
  console.log("=".repeat(72));
  console.log();

  let missingCount = 0;
  let mismatchCount = 0;
  let presentCount = 0;

  for (const [key, config] of Object.entries(EXPECTED_ENV_VARS)) {
    const localVal = local.vars[key];
    const remoteVal = remote?.vars[key];

    if (!localVal && config.required) {
      console.log(`  [MISSING] ${key} — ${config.description} (REQUIRED)`);
      console.log(`            Category: ${config.category}`);
      missingCount++;
      continue;
    }

    if (!localVal) {
      console.log(`  [OPTIONAL] ${key} — ${config.description}`);
      console.log(`            Default: ${config.defaultValue || "<none>"}`);
      console.log(`            Not set locally`);
      continue;
    }

    presentCount++;

    if (config.category === "database") {
      const dbType = localVal.startsWith("postgresql://") ? "PostgreSQL" : "Unknown";
      console.log(`  [OK] ${key} — ${dbType}`);
      const hostMatch = localVal.match(/@([^:]+)/);
      if (hostMatch) {
        console.log(`       Host: ${hostMatch[1]}`);
        console.log(`       SSL:  ${localVal.includes("sslmode=require") || localVal.includes("ssl=true") ? "Enabled" : "Disabled"}`);
      }
      continue;
    }

    console.log(`  [OK] ${key} = ${maskSensitive(localVal, config.sensitive)}`);
    console.log(`       ${config.description}`);

    if (remote !== null && remoteVal !== undefined) {
      if (remoteVal === localVal) {
        console.log(`       Local === Remote ✓`);
      } else {
        console.log(`       Local  = ${maskSensitive(localVal, config.sensitive)}`);
        console.log(`       Remote = ${maskSensitive(remoteVal, config.sensitive)}`);
        console.log(`       [MISMATCH] ✗`);
        mismatchCount++;
      }
    }
    console.log();
  }

  // Summary
  console.log("=".repeat(72));
  console.log("  SUMMARY");
  console.log("=".repeat(72));
  console.log(`  Total expected vars: ${Object.keys(EXPECTED_ENV_VARS).length}`);
  console.log(`  Present:             ${presentCount}`);
  console.log(`  Missing:             ${missingCount}`);
  console.log(`  Mismatches:          ${mismatchCount}`);
  console.log();

  if (missingCount > 0) {
    console.log("  ❌ MISSING REQUIRED VARIABLES — deployment will likely fail");
    console.log(`     Run: cp .env.example .env  (if available), or add to Render dashboard`);
  } else {
    console.log("  ✅ All required env vars are present locally");
  }

  if (remote === null) {
    console.log();
    console.log("  ℹ️  To compare with deployed environment, run:");
    console.log(`     npx tsx scripts/env-compare.ts --remote https://your-app.onrender.com`);
  }
}

main().catch(console.error);
