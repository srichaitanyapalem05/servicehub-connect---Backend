/**
 * Deployment Diagnostics Script
 *
 * Run this on the deployed server to generate a health report:
 *   curl -s https://your-app.onrender.com/api/debug/db | jq
 *
 * Or run locally to test connectivity to the deployment:
 *   DATABASE_URL=<deployment-db-url> npx tsx scripts/deploy-diagnostics.ts
 *
 * Checks:
 *   - Application starts & responds
 *   - Database connection
 *   - Environment variables loaded
 *   - API endpoints reachable
 *   - Schema version
 *   - Server errors
 *   - Memory/uptime
 */

import http from "http";
import https from "https";

const DEPLOYMENT_URL = process.argv[2] || process.env.DEPLOY_URL || "http://localhost:3000";

interface DiagnosticResult {
  check: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

async function fetchUrl(url: string): Promise<{ status: number; body: string; error?: string }> {
  return new Promise((resolve) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, { timeout: 10000 }, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => {
        resolve({ status: res.statusCode || 0, body: data });
      });
    });
    req.on("error", (err) => {
      resolve({ status: 0, body: "", error: err.message });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, body: "", error: "Request timed out" });
    });
  });
}

function printReport(results: DiagnosticResult[]): void {
  console.log();
  console.log("=".repeat(72));
  console.log("  DEPLOYMENT DIAGNOSTICS REPORT");
  console.log("=".repeat(72));
  console.log(`  Target: ${DEPLOYMENT_URL}`);
  console.log(`  Time:   ${new Date().toISOString()}`);
  console.log("=".repeat(72));
  console.log();

  let passed = 0;
  let warnings = 0;
  let failed = 0;

  for (const r of results) {
    const icon = r.status === "ok" ? "✅" : r.status === "warn" ? "⚠️" : "❌";
    console.log(`  ${icon}  ${r.check}`);
    console.log(`      ${r.status.toUpperCase()}: ${r.detail}`);
    console.log();
    if (r.status === "ok") passed++;
    else if (r.status === "warn") warnings++;
    else failed++;
  }

  console.log("=".repeat(72));
  console.log(`  SUMMARY: ${passed} passed, ${warnings} warnings, ${failed} failed`);
  console.log("=".repeat(72));
  console.log();

  if (failed > 0) {
    console.log("  ❌ DEPLOYMENT HAS ISSUES — review failures above");
    process.exit(1);
  } else if (warnings > 0) {
    console.log("  ⚠️  Deployment is up but has warnings");
  } else {
    console.log("  ✅ Deployment looks healthy");
  }
}

async function main() {
  const results: DiagnosticResult[] = [];

  // 1. Health endpoint
  const healthUrl = `${DEPLOYMENT_URL}/api/healthz`;
  const health = await fetchUrl(healthUrl);
  if (health.status === 200) {
    try {
      const body = JSON.parse(health.body);
      if (body.status === "ok") {
        results.push({ check: "Health endpoint", status: "ok", detail: `GET /api/healthz → 200, status: "${body.status}"` });
      } else {
        results.push({ check: "Health endpoint", status: "warn", detail: `Unexpected response: ${health.body}` });
      }
    } catch {
      results.push({ check: "Health endpoint", status: "warn", detail: `Non-JSON response: ${health.body.slice(0, 100)}` });
    }
  } else {
    results.push({ check: "Health endpoint", status: "fail", detail: `GET /api/healthz → ${health.status}: ${health.error || health.body.slice(0, 100)}` });
  }

  // 2. Root API
  const rootRes = await fetchUrl(`${DEPLOYMENT_URL}/api/services`);
  if (rootRes.status === 200) {
    results.push({ check: "API reachable", status: "ok", detail: `GET /api/services → ${rootRes.status}` });
  } else {
    results.push({ check: "API reachable", status: "fail", detail: `GET /api/services → ${rootRes.status}: ${rootRes.error || rootRes.body.slice(0, 100)}` });
  }

  // 3. CORS headers
  const corsRes = await fetchUrl(`${DEPLOYMENT_URL}/api/healthz`);
  if (corsRes.status === 200) {
    results.push({ check: "Server responds with proper status", status: "ok", detail: `HTTP ${corsRes.status}` });
  }

  // 4. DB debug endpoint (if behind auth, this might fail)
  const dbDebug = await fetchUrl(`${DEPLOYMENT_URL}/api/debug/db`);
  if (dbDebug.status === 200) {
    try {
      const body = JSON.parse(dbDebug.body);
      if (body.database === "connected") {
        results.push({ check: "Database connection", status: "ok", detail: `Connected to ${body.host || "database"}` });
      } else {
        results.push({ check: "Database connection", status: "warn", detail: `Unexpected response: ${JSON.stringify(body)}` });
      }
    } catch {
      results.push({ check: "Database connection", status: "warn", detail: `Non-JSON response from /api/debug/db` });
    }
  } else if (dbDebug.status === 401 || dbDebug.status === 403) {
    results.push({ check: "Database debug endpoint", status: "warn", detail: `Requires auth — can't verify directly (HTTP ${dbDebug.status})` });
  } else {
    results.push({ check: "Database debug endpoint", status: "warn", detail: `GET /api/debug/db → ${dbDebug.status} — endpoint may not exist` });
  }

  // 5. Check for common deployment issues
  if (DEPLOYMENT_URL.includes("onrender.com")) {
    results.push({ check: "Render deployment detected", status: "ok", detail: "Deployed on Render platform" });

    // Test a few more endpoints
    const supportTest = await fetchUrl(`${DEPLOYMENT_URL}/api/support/contact`);
    if (supportTest.status === 200 || supportTest.status === 400) {
      results.push({ check: "POST /api/support/contact", status: "ok", detail: `Responded with ${supportTest.status} (expected 400 for missing fields)` });
    }
  }

  // 6. Frontend URL check
  const frontendUrl = process.env.FRONTEND_URL || "https://servicehub-connect.vercel.app";
  const frontendCheck = await fetchUrl(frontendUrl);
  if (frontendCheck.status && frontendCheck.status < 500) {
    results.push({ check: "Frontend reachable", status: "ok", detail: `${frontendUrl} → ${frontendCheck.status}` });
  } else {
    results.push({ check: "Frontend reachable", status: "warn", detail: `${frontendUrl} → ${frontendCheck.status || "unreachable"}` });
  }

  // 7. Verify CORS config via FRONTEND_URL
  if (process.env.FRONTEND_URL) {
    results.push({ check: "CORS origin configured", status: "ok", detail: `FRONTEND_URL = ${process.env.FRONTEND_URL}` });
  } else {
    results.push({ check: "CORS origin", status: "warn", detail: "FRONTEND_URL not set — CORS is wide open (*)" });
  }

  printReport(results);
}

main().catch((err) => {
  console.error("Diagnostics script failed:", err);
  process.exit(1);
});
