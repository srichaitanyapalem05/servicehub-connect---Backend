/**
 * Admin Seed Script
 * Creates the first admin account from .env credentials.
 * Run once: node scripts/seed-admin.js
 */

import pg from "pg";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load .env manually ─────────────────────────────────────────
const envPath = resolve(__dirname, "../.env");
const envContent = readFileSync(envPath, "utf-8");
const env = {};
for (const line of envContent.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const idx = trimmed.indexOf("=");
  if (idx === -1) continue;
  const key = trimmed.slice(0, idx).trim();
  const value = trimmed.slice(idx + 1).trim();
  env[key] = value;
}

const DATABASE_URL = env.DATABASE_URL;
const ADMIN_EMAIL   = env.ADMIN_EMAIL;
const ADMIN_PASSWORD = env.ADMIN_PASSWORD;
const ADMIN_NAME    = env.ADMIN_NAME || "Super Admin";

// ── Validate ───────────────────────────────────────────────────
if (!DATABASE_URL) {
  console.error("❌  DATABASE_URL is missing in .env");
  process.exit(1);
}
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error("❌  ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env");
  process.exit(1);
}

// ── Connect to DB ──────────────────────────────────────────────
const { Pool } = pg;
const pool = new Pool({ connectionString: DATABASE_URL });

async function seedAdmin() {
  const client = await pool.connect();
  try {
    console.log("\n🔧  ServiceHub — Admin Seed Script");
    console.log("─────────────────────────────────────");

    // Check if admin already exists
    const existing = await client.query(
      "SELECT id, email, role FROM users WHERE email = $1",
      [ADMIN_EMAIL]
    );

    if (existing.rows.length > 0) {
      const user = existing.rows[0];
      if (user.role === "admin") {
        console.log(`✅  Admin already exists: ${user.email}`);
        console.log("    No changes made.\n");
        return;
      } else {
        // User exists but not admin — promote to admin
        await client.query(
          "UPDATE users SET role = 'admin' WHERE email = $1",
          [ADMIN_EMAIL]
        );
        console.log(`✅  Existing user promoted to admin: ${ADMIN_EMAIL}\n`);
        return;
      }
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, 12);
    const id = randomUUID();

    // Insert admin user
    await client.query(
      `INSERT INTO users (id, name, email, password, role, created_at)
       VALUES ($1, $2, $3, $4, 'admin', NOW())`,
      [id, ADMIN_NAME, ADMIN_EMAIL, hashedPassword]
    );

    console.log("✅  Admin account created successfully!");
    console.log(`    Name:  ${ADMIN_NAME}`);
    console.log(`    Email: ${ADMIN_EMAIL}`);
    console.log("\n🔐  You can now login at http://localhost:8080/login");
    console.log("    After login you will be redirected to /admin dashboard\n");

  } catch (err) {
    console.error("❌  Error creating admin:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seedAdmin();
