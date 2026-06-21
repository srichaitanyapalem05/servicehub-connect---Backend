#!/usr/bin/env bash
# Deployment Readiness Checklist
#
# Usage:
#   chmod +x scripts/check-deploy-ready.sh
#   ./scripts/check-deploy-ready.sh
#
# Checks every item and prints pass/fail for each.

set -e

PASS=0
FAIL=0
WARN=0
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { PASS=$((PASS+1)); echo -e "  ${GREEN}✅ PASS${NC} $1"; }
fail() { FAIL=$((FAIL+1)); echo -e "  ${RED}❌ FAIL${NC} $1"; }
warn() { WARN=$((WARN+1)); echo -e "  ${YELLOW}⚠️  WARN${NC} $1"; }

echo ""
echo "========================================"
echo "  DEPLOYMENT READINESS CHECKLIST"
echo "========================================"
echo "  $(date)"
echo "========================================"
echo ""

# ── 1. Environment Variables ──────────────────────────────────
echo "--- Environment Variables ---"

if [ -n "$DATABASE_URL" ]; then
  pass "DATABASE_URL is set"
else
  fail "DATABASE_URL is not set"
fi

if [ -n "$JWT_SECRET" ]; then
  pass "JWT_SECRET is set"
else
  fail "JWT_SECRET is not set"
fi

if [ -n "$PORT" ]; then
  pass "PORT = $PORT"
else
  warn "PORT not set, default 3000 will be used"
fi

if [ "$NODE_ENV" = "production" ]; then
  pass "NODE_ENV = production"
elif [ -z "$NODE_ENV" ]; then
  warn "NODE_ENV is not set (defaults to development)"
else
  warn "NODE_ENV = $NODE_ENV (not production)"
fi

if [ -n "$EMAIL_USER" ]; then
  pass "EMAIL_USER is set"
else
  warn "EMAIL_USER not set — OTP emails will fail"
fi

if [ -n "$EMAIL_PASS" ]; then
  pass "EMAIL_PASS is set"
else
  warn "EMAIL_PASS not set — OTP emails will fail"
fi

if [ -n "$ADMIN_EMAIL" ]; then
  pass "ADMIN_EMAIL is set"
else
  warn "ADMIN_EMAIL not set — no auto-created admin"
fi

if [ -n "$ADMIN_PASSWORD" ]; then
  pass "ADMIN_PASSWORD is set"
else
  warn "ADMIN_PASSWORD not set"
fi

if [ -n "$FRONTEND_URL" ]; then
  pass "FRONTEND_URL is set to $FRONTEND_URL"
else
  warn "FRONTEND_URL not set — CORS will allow all origins"
fi

# ── 2. Application ────────────────────────────────────────────
echo ""
echo "--- Application ---"

if [ -f "package.json" ]; then
  pass "package.json exists"
else
  fail "package.json missing"
fi

if [ -f "server.ts" ]; then
  pass "server.ts exists"
else
  fail "server.ts missing"
fi

if [ -f "node_modules/.package-lock.json" ] || [ -f "node_modules/.pnpm-lock.json" ]; then
  pass "node_modules installed"
else
  warn "node_modules may not be installed"
fi

# ── 3. Database ───────────────────────────────────────────────
echo ""
echo "--- Database ---"

if command -v psql &>/dev/null; then
  if [ -n "$DATABASE_URL" ]; then
    if psql "$DATABASE_URL" -c "SELECT 1" &>/dev/null 2>&1; then
      pass "Database is reachable"
    else
      fail "Cannot connect to database — check DATABASE_URL"
    fi
  fi
else
  warn "psql not found — skipping DB connectivity check"
fi

# ── 4. Configuration Files ────────────────────────────────────
echo ""
echo "--- Configuration Files ---"

for f in "render.yaml" "nixpacks.toml" "package.json" "tsconfig.json"; do
  if [ -f "$f" ]; then
    pass "$f exists"
  else
    fail "$f missing"
  fi
done

# ── 5. API Sanity ─────────────────────────────────────────────
echo ""
echo "--- API Health (if server is running) ---"

if curl -sf "http://localhost:${PORT:-3000}/api/healthz" &>/dev/null 2>&1; then
  pass "Local server responds on port ${PORT:-3000}"
elif curl -sf "http://localhost:3000/api/healthz" &>/dev/null 2>&1; then
  pass "Local server responds on port 3000"
else
  warn "Server not running locally — skipping API health check"
fi

# ── 6. Summary ────────────────────────────────────────────────
echo ""
echo "========================================"
echo "  RESULTS"
echo "========================================"
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo "  WARN: $WARN"
echo "========================================"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "  ❌ NOT READY — fix failures before deploying"
  exit 1
elif [ "$WARN" -gt 0 ]; then
  echo "  ⚠️  Ready with warnings — review warnings above"
else
  echo "  ✅ READY FOR DEPLOYMENT"
fi
echo ""
