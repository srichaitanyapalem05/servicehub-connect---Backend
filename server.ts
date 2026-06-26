/**
 * ============================================================
 *  Multi-Vendor Service Booking Platform — Backend
 *  Single-file version combining all modules
 *
 *  Stack: Node.js · Express 5 · PostgreSQL · Drizzle ORM
 *         JWT Auth · bcryptjs · express-validator
 *
 *  Required env vars:
 *    DATABASE_URL   – PostgreSQL connection string
 *    JWT_SECRET     – Secret for signing JWT tokens
 *    PORT           – Port to listen on (default: 3000)
 * ============================================================
 */

import { randomUUID } from "crypto";
import path from "path";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  Router,
} from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";
import { body, validationResult } from "express-validator";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  pgTable,
  pgEnum,
  text,
  boolean,
  real,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import {
  eq,
  and,
  gte,
  lte,
  ilike,
  asc,
  desc,
  count,
  avg,
} from "drizzle-orm";

// ============================================================
// SECTION 1 — DATABASE CONNECTION (lazy init)
// ============================================================

let pool: any = null;
let db: ReturnType<typeof drizzle> = null as any;

async function initDb() {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  db = drizzle(DATABASE_URL);
  pool = (db as any).$client;
}

// ============================================================
// SECTION 1B — EMAIL & OTP SETUP
// ============================================================

// OTP stored in DB (not memory) to survive server restarts
async function saveOtp(email: string, entry: { otp: string; expiresAt: number; name: string; password: string; role: "customer" | "vendor"; businessName?: string; purpose?: string }) {
  await pool.query(
    `INSERT INTO otp_store (email, otp, expires_at, name, password, role, business_name, purpose)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (email) DO UPDATE SET
       otp = EXCLUDED.otp, expires_at = EXCLUDED.expires_at,
       name = EXCLUDED.name, password = EXCLUDED.password,
       role = EXCLUDED.role, business_name = EXCLUDED.business_name,
       purpose = EXCLUDED.purpose`,
    [email, entry.otp, entry.expiresAt, entry.name, entry.password, entry.role, entry.businessName || null, entry.purpose || 'signup']
  );
}

async function getOtp(email: string, purpose?: string) {
  const query = purpose
    ? `SELECT * FROM otp_store WHERE email = $1 AND purpose = $2`
    : `SELECT * FROM otp_store WHERE email = $1`;
  const params = purpose ? [email, purpose] : [email];
  const result = await pool.query(query, params);
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    otp: row.otp,
    expiresAt: Number(row.expires_at),
    name: row.name,
    password: row.password,
    role: row.role as "customer" | "vendor",
    businessName: row.business_name,
    purpose: row.purpose,
  };
}

async function deleteOtp(email: string) {
  await pool.query(`DELETE FROM otp_store WHERE email = $1`, [email]);
}

// Nodemailer transporter — Gmail (local dev only)
const mailer = nodemailer.createTransport(
  process.env.RESEND_API_KEY
    ? {
        host: "smtp.resend.com",
        port: 465,
        secure: true,
        auth: { user: "resend", pass: process.env.RESEND_API_KEY },
      }
    : {
        service: "gmail",
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 20000,
        tls: { rejectUnauthorized: false },
      }
);

function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendOtpEmail(to: string, otp: string, name: string): Promise<void> {
  console.log(`[OTP] Code for ${to} (${name}): ${otp}`);
  if (process.env.BYPASS_OTP === "true") {
    console.log(`[OTP] BYPASS MODE — email not sent`);
    return;
  }
  await mailer.sendMail({
    from: process.env.RESEND_API_KEY
      ? `"Atelier Services" <onboarding@resend.dev>`
      : `"Atelier Services" <${process.env.EMAIL_USER}>`,
    to,
    subject: "Your Atelier Services verification code",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#fafafa;border-radius:12px">
        <h2 style="margin:0 0 8px;color:#111">Hi ${name},</h2>
        <p style="color:#555;margin:0 0 24px">Use the code below to verify your email address. It expires in <strong>10 minutes</strong>.</p>
        <div style="background:#111;color:#fff;font-size:36px;font-weight:700;letter-spacing:12px;text-align:center;padding:24px;border-radius:8px">
          ${otp}
        </div>
        <p style="color:#999;font-size:13px;margin:24px 0 0">If you didn't create an account, you can safely ignore this email.</p>
      </div>
    `,
  });
  console.log(`[OTP] Email sent to ${to}`);
}

// ============================================================
// SECTION 2 — DATABASE SCHEMA (Drizzle ORM)
// ============================================================

// Enums
const roleEnum = pgEnum("role", ["customer", "vendor", "admin"]);
const bookingStatusEnum = pgEnum("booking_status", [
  "pending",
  "confirmed",
  "completed",
  "cancelled",
]);
const paymentStatusEnum = pgEnum("payment_status", ["unpaid", "paid"]);

// Users table
const usersTable = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  password: text("password").notNull(),
  role: roleEnum("role").notNull().default("customer"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Vendors table
const vendorsTable = pgTable("vendors", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  businessName: text("business_name").notNull(),
  isApproved: boolean("is_approved").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Services table
const servicesTable = pgTable("services", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  price: real("price").notNull(),
  category: text("category").notNull(),
  vendorId: text("vendor_id")
    .notNull()
    .references(() => vendorsTable.id, { onDelete: "cascade" }),
  rating: real("rating").notNull().default(0),
  reviewCount: integer("review_count").notNull().default(0),
  status: text("status").notNull().default("pending"),
  phone: text("phone"),
  experience: integer("experience").default(0),
  licenseNo: text("license_no"),
  location: text("location"),
  portfolio: text("portfolio"),
  backgroundCheck: boolean("background_check").default(false),
  images: text("images").default("[]"),
  lat: real("lat"),
  lng: real("lng"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Bookings table
const bookingsTable = pgTable("bookings", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  vendorId: text("vendor_id")
    .notNull()
    .references(() => vendorsTable.id, { onDelete: "cascade" }),
  serviceId: text("service_id")
    .notNull()
    .references(() => servicesTable.id, { onDelete: "cascade" }),
  date: text("date").notNull(),
  time: text("time").notNull(),
  status: bookingStatusEnum("status").notNull().default("pending"),
  paymentStatus: paymentStatusEnum("payment_status").notNull().default("unpaid"),
  customerName: text("customer_name"),
  customerEmail: text("customer_email"),
  customerPhone: text("customer_phone"),
  address: text("address"),
  totalAmount: real("total_amount"),
  couponCode: text("coupon_code"),
  completionPhotos: text("completion_photos").default("[]"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Reviews table
const reviewsTable = pgTable("reviews", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  serviceId: text("service_id")
    .notNull()
    .references(() => servicesTable.id, { onDelete: "cascade" }),
  bookingId: text("booking_id")
    .notNull()
    .references(() => bookingsTable.id, { onDelete: "cascade" }),
  vendorId: text("vendor_id")
    .notNull()
    .references(() => vendorsTable.id, { onDelete: "cascade" }),
  rating: real("rating").notNull(),
  title: text("title").default(""),
  comment: text("comment").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Promo Codes table
const promoStatusEnum = pgEnum("promo_status", ["active", "inactive", "expired"]);
const promoDiscountTypeEnum = pgEnum("promo_discount_type", ["percent", "flat"]);

const promoCodesTable = pgTable("promo_codes", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  discountType: promoDiscountTypeEnum("discount_type").notNull().default("percent"),
  discountValue: real("discount_value").notNull(),
  minBookingAmount: real("min_booking_amount").default(0),
  maxDiscount: real("max_discount"),
  validUntil: timestamp("valid_until").notNull(),
  category: text("category").default("all"),
  firstTimeOnly: boolean("first_time_only").default(false),
  oneTimePerUser: boolean("one_time_per_user").default(false),
  isActive: boolean("is_active").default(true),
  usageCount: integer("usage_count").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Promo Usage table
const usageStatusEnum = pgEnum("usage_status", ["used", "reused"]);

const promoUsageTable = pgTable("promo_usage", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  bookingId: text("booking_id")
    .notNull()
    .references(() => bookingsTable.id, { onDelete: "cascade" }),
  promoCodeId: text("promo_code_id")
    .notNull()
    .references(() => promoCodesTable.id, { onDelete: "cascade" }),
  usedAt: timestamp("used_at").defaultNow().notNull(),
  bookingStatus: text("booking_status").notNull().default("pending"),
  eligibleForReuse: boolean("eligible_for_reuse").default(false),
  reuseCount: integer("reuse_count").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Notifications table
const notificationTypeEnum = pgEnum("notification_type", [
  "booking_confirmed",
  "booking_completed",
  "booking_cancelled",
  "review_request",
  "promo_eligible",
  "service_approved",
  "general",
]);

const notificationsTable = pgTable("notifications", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  message: text("message").notNull(),
  type: notificationTypeEnum("type").notNull().default("general"),
  isRead: boolean("is_read").default(false),
  redirectUrl: text("redirect_url"),
  bookingId: text("booking_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ============================================================
// SECTION 3 — TYPES
// ============================================================

interface AuthRequest extends Request {
  user?: { id: string; role: string; email: string };
}

// ============================================================
// SECTION 4 — UTILITIES
// ============================================================

function generateId(): string {
  return randomUUID();
}

function getPagination(query: Record<string, unknown>) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 10));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

function buildPagination(page: number, limit: number, total: number) {
  return { page, limit, total, pages: Math.ceil(total / limit) };
}

// ============================================================
// SECTION 5 — AUTH HELPERS
// ============================================================

const JWT_SECRET =
  process.env.JWT_SECRET ?? process.env.SESSION_SECRET ?? "change-me-in-production";

function generateToken(payload: { id: string; role: string; email: string }): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

// ============================================================
// SECTION 6 — MIDDLEWARE
// ============================================================

// JWT authentication middleware
function authenticate(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  let token: string | undefined;
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.split(" ")[1];
  } else if (req.query.token) {
    // Allow token via query param (used for SSE which can't set headers)
    token = req.query.token as string;
  }
  if (!token) {
    res.status(401).json({ success: false, message: "No token provided" });
    return;
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET) as { id: string; role: string; email: string };
    next();
  } catch {
    res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
}

// Role-based access control middleware
function requireRole(...roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Not authenticated" });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ success: false, message: "Forbidden: insufficient permissions" });
      return;
    }
    next();
  };
}

// express-validator result middleware
function validate(req: Request, res: Response, next: NextFunction): void {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({
      success: false,
      message: "Validation failed",
      errors: errors.array().map((e) => ({
        field: e.type === "field" ? e.path : "unknown",
        message: e.msg,
      })),
    });
    return;
  }
  next();
}

// Global error handler
function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  console.error("[ERROR]", err);
  res.status(500).json({ success: false, message: "Internal server error" });
}

// ============================================================
// SECTION 7 — CONTROLLERS
// ============================================================

// ── Auth ─────────────────────────────────────────────────────

async function registerCustomer(req: Request, res: Response): Promise<void> {
  const { name, email, password } = req.body as { name: string; email: string; password: string };

  const existing = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (existing.length > 0) {
    res.status(400).json({ success: false, message: "Email already registered" });
    return;
  }



  const otp = generateOtp();
  const expiresAt = Date.now() + 10 * 60 * 1000;

  const hashPromise = bcrypt.hash(password, 10);
  await saveOtp(email, { otp, expiresAt, name, password: await hashPromise, role: "customer" });

  // Fire-and-forget email — respond immediately so the user sees the OTP screen
  sendOtpEmail(email, otp, name).catch((err) => {
    console.error(`[OTP] Background email failed for ${email}:`, err?.message);
  });

  res.status(200).json({
    success: true,
    message: "OTP sent to your email. Please verify to complete registration.",
  });
}

async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as { email: string; password: string };

  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (!user) {
    res.status(401).json({ success: false, message: "Invalid credentials" });
    return;
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    res.status(401).json({ success: false, message: "Invalid credentials" });
    return;
  }

  const token = generateToken({ id: user.id, role: user.role, email: user.email });
  res.json({
    success: true,
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt },
  });
}

async function getUserProfile(req: AuthRequest, res: Response): Promise<void> {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, req.user!.id))
    .limit(1);

  if (!user) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt });
}

async function verifyOtp(req: Request, res: Response): Promise<void> {
  const { email, otp } = req.body as { email: string; otp: string };

  const entry = await getOtp(email);

  if (!entry) {
    res.status(400).json({ success: false, message: "No OTP found for this email. Please register again." });
    return;
  }

  if (Date.now() > entry.expiresAt) {
    await deleteOtp(email);
    res.status(400).json({ success: false, message: "OTP has expired. Please register again." });
    return;
  }

  if (entry.otp !== otp) {
    res.status(400).json({ success: false, message: "Invalid OTP. Please try again." });
    return;
  }

  // OTP is valid — create the user in DB
  const id = generateId();
  const [user] = await db
    .insert(usersTable)
    .values({ id, name: entry.name, email, password: entry.password, role: entry.role })
    .returning();

  // If vendor, also create vendor profile
  let vendor = null;
  if (entry.role === "vendor" && entry.businessName) {
    const [v] = await db
      .insert(vendorsTable)
      .values({ id: generateId(), userId: user.id, businessName: entry.businessName, isApproved: false })
      .returning();
    vendor = { id: v.id, businessName: v.businessName, isApproved: v.isApproved };
  }

  await deleteOtp(email);

  const token = generateToken({ id: user.id, role: user.role, email: user.email });
  res.status(201).json({
    success: true,
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt },
    ...(vendor && { vendor }),
  });
}

async function resendOtp(req: Request, res: Response): Promise<void> {
  const { email } = req.body as { email: string };

  const entry = await getOtp(email);
  if (!entry) {
    res.status(400).json({ success: false, message: "No pending registration for this email." });
    return;
  }

  const otp = generateOtp();
  entry.otp = otp;
  entry.expiresAt = Date.now() + 10 * 60 * 1000;
  await saveOtp(email, entry);

  sendOtpEmail(email, otp, entry.name).catch((err) => {
    console.error(`[OTP] Background email failed for ${email}:`, err?.message);
  });

  res.json({ success: true, message: "A new OTP has been sent to your email." });
}

// ── Login with OTP ──────────────────────────────────────────

async function sendLoginOtp(req: Request, res: Response): Promise<void> {
  const { email } = req.body as { email: string };

  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (!user) {
    res.status(404).json({ success: false, message: "No account found with this email." });
    return;
  }

  const otp = generateOtp();
  const expiresAt = Date.now() + 10 * 60 * 1000;

  await saveOtp(email, { otp, expiresAt, name: user.name, password: user.password, role: user.role as "customer" | "vendor", purpose: "login" });

  sendOtpEmail(email, otp, user.name).catch((err) => {
    console.error(`[OTP] Background email failed for ${email}:`, err?.message);
  });

  res.json({ success: true, message: "OTP sent to your email." });
}

async function verifyLoginOtp(req: Request, res: Response): Promise<void> {
  const { email, otp } = req.body as { email: string; otp: string };

  const entry = await getOtp(email, "login");
  if (!entry) {
    res.status(400).json({ success: false, message: "No OTP found for this email. Please request a new one." });
    return;
  }

  if (Date.now() > entry.expiresAt) {
    await deleteOtp(email);
    res.status(400).json({ success: false, message: "OTP has expired. Please request a new one." });
    return;
  }

  if (entry.otp !== otp) {
    res.status(400).json({ success: false, message: "Invalid OTP. Please try again." });
    return;
  }

  await deleteOtp(email);

  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (!user) {
    res.status(404).json({ success: false, message: "Account not found." });
    return;
  }

  const token = generateToken({ id: user.id, role: user.role, email: user.email });
  res.json({
    success: true,
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt },
  });
}

// ── Vendor ───────────────────────────────────────────────────

async function registerVendor(req: Request, res: Response): Promise<void> {
  const { name, email, password, businessName } = req.body as {
    name: string; email: string; password: string; businessName: string;
  };

  const existing = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (existing.length > 0) {
    res.status(400).json({ success: false, message: "Email already registered" });
    return;
  }

  const otp = generateOtp();
  const expiresAt = Date.now() + 10 * 60 * 1000;

  const hashPromise = bcrypt.hash(password, 10);
  await saveOtp(email, { otp, expiresAt, name, password: await hashPromise, role: "vendor", businessName });

  sendOtpEmail(email, otp, name).catch((err) => {
    console.error(`[OTP] Background email failed for ${email}:`, err?.message);
  });

  res.status(200).json({
    success: true,
    message: "OTP sent to your email. Please verify to complete registration.",
  });
}

async function vendorLogin(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as { email: string; password: string };

  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (!user || user.role !== "vendor") {
    res.status(401).json({ success: false, message: "Invalid credentials or not a vendor" });
    return;
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    res.status(401).json({ success: false, message: "Invalid credentials" });
    return;
  }

  const token = generateToken({ id: user.id, role: user.role, email: user.email });
  res.json({
    success: true,
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt },
  });
}

async function getVendorDashboard(req: AuthRequest, res: Response): Promise<void> {
  const [vendor] = await db
    .select()
    .from(vendorsTable)
    .where(eq(vendorsTable.userId, req.user!.id))
    .limit(1);

  if (!vendor) {
    res.status(404).json({ success: false, message: "Vendor profile not found" });
    return;
  }

  const [serviceCount] = await db
    .select({ count: count() })
    .from(servicesTable)
    .where(eq(servicesTable.vendorId, vendor.id));

  const allBookings = await db
    .select({ status: bookingsTable.status, paymentStatus: bookingsTable.paymentStatus, serviceId: bookingsTable.serviceId })
    .from(bookingsTable)
    .where(eq(bookingsTable.vendorId, vendor.id));

  let totalEarnings = 0;
  for (const b of allBookings.filter((b) => b.paymentStatus === "paid")) {
    const [svc] = await db
      .select({ price: servicesTable.price })
      .from(servicesTable)
      .where(eq(servicesTable.id, b.serviceId))
      .limit(1);
    if (svc) totalEarnings += svc.price;
  }

  res.json({
    success: true,
    data: {
      totalServices: serviceCount?.count ?? 0,
      totalBookings: allBookings.length,
      pendingBookings: allBookings.filter((b) => b.status === "pending").length,
      confirmedBookings: allBookings.filter((b) => b.status === "confirmed").length,
      completedBookings: allBookings.filter((b) => b.status === "completed").length,
      totalEarnings,
    },
  });
}

async function getVendorBookings(req: AuthRequest, res: Response): Promise<void> {
  const { status } = req.query as { status?: string };
  const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);

  const [vendor] = await db
    .select()
    .from(vendorsTable)
    .where(eq(vendorsTable.userId, req.user!.id))
    .limit(1);

  if (!vendor) {
    res.status(404).json({ success: false, message: "Vendor profile not found" });
    return;
  }

  const statusFilter = status ? `AND b.status = '${status}'` : "";

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM bookings b WHERE b.vendor_id = $1 ${statusFilter}`,
    [vendor.id]
  );

  const result = await pool.query(
    `SELECT
        b.id, b.date, b.time, b.status, b.payment_status as "paymentStatus",
        b.address, b.customer_name as "customerName", b.customer_email as "customerEmail",
        b.customer_phone as "customerPhone", b.total_amount as "totalAmount",
        b.coupon_code as "couponCode", b.completion_photos as "completionPhotos", b.created_at as "createdAt",
        b.user_id as "userId", b.vendor_id as "vendorId", b.service_id as "serviceId",
        s.id as "serviceId", s.title as "serviceTitle", s.price as "servicePrice",
        s.category as "serviceCategory", s.images as "serviceImages",
        u.name as "userName", u.email as "userEmail"
     FROM bookings b
     LEFT JOIN services s ON s.id = b.service_id
     LEFT JOIN users u ON u.id = b.user_id
     WHERE b.vendor_id = $1 ${statusFilter}
     ORDER BY b.created_at DESC
     LIMIT ${limit} OFFSET ${offset}`,
    [vendor.id]
  );

  const bookings = result.rows.map(b => ({
    ...b,
    total: b.totalAmount ?? b.servicePrice ?? 0,
    serviceImage: (() => {
      try {
        const imgs = b.serviceImages ? JSON.parse(b.serviceImages) : [];
        return imgs[0] || "";
      } catch { return ""; }
    })(),
    completionPhotos: (() => {
      try {
        return b.completionPhotos ? JSON.parse(b.completionPhotos) : [];
      } catch { return []; }
    })(),
  }));

  res.json({
    success: true,
    data: bookings,
    pagination: buildPagination(page, limit, Number(countResult.rows[0]?.count ?? 0)),
  });
}



// ── Services ──────────────────────────────────────────────────

async function getServices(req: Request, res: Response): Promise<void> {
  const {
    category, minPrice, maxPrice, minRating, search,
    sortBy = "createdAt", sortOrder = "desc",
    lat, lng, radius,
  } = req.query as Record<string, string | undefined>;

  const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);

  const conditions: any[] = [eq(servicesTable.status, "approved")];
  if (category) conditions.push(eq(servicesTable.category, category));
  if (minPrice) conditions.push(gte(servicesTable.price, Number(minPrice)));
  if (maxPrice) conditions.push(lte(servicesTable.price, Number(maxPrice)));
  if (minRating) conditions.push(gte(servicesTable.rating, Number(minRating)));
  if (search) conditions.push(ilike(servicesTable.title, `%${search}%`));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // If lat/lng/radius provided, use Haversine distance filtering
  const useGeo = lat && lng && radius;
  const distanceSelect = useGeo
    ? `, CASE WHEN s.lat IS NOT NULL AND s.lng IS NOT NULL THEN (6371 * acos(LEAST(1.0, cos(radians(${Number(lat)})) * cos(radians(s.lat)) * cos(radians(s.lng) - radians(${Number(lng)})) + sin(radians(${Number(lat)})) * sin(radians(s.lat))))) ELSE NULL END AS distance`
    : ", NULL AS distance";
  const geoFilter = useGeo
    ? `AND (s.lat IS NULL OR s.lng IS NULL OR (6371 * acos(LEAST(1.0, cos(radians(${Number(lat)})) * cos(radians(s.lat)) * cos(radians(s.lng) - radians(${Number(lng)})) + sin(radians(${Number(lat)})) * sin(radians(s.lat))))) <= ${Number(radius)})`
    : "";

  const [totalResult] = await db.select({ count: count() }).from(servicesTable).where(whereClause);
  const services = await pool.query(
    `SELECT s.id, s.title, s.description, s.price, s.category,
            s.vendor_id as "vendorId", s.rating, s.review_count as "reviewCount",
            s.status, s.phone, s.experience, s.license_no as "licenseNo",
            s.location, s.portfolio, s.background_check as "backgroundCheck",
            s.images, s.lat, s.lng, s.created_at as "createdAt",
            v.business_name as "vendorName"
            ${distanceSelect}
     FROM services s
     LEFT JOIN vendors v ON v.id = s.vendor_id
     WHERE s.status = 'approved'
     ${category ? `AND s.category = '${category.replace(/'/g, "''")}'` : ""}
     ${search ? `AND s.title ILIKE '%${search.replace(/'/g, "''")}%'` : ""}
     ${minPrice ? `AND s.price >= ${Number(minPrice)}` : ""}
     ${maxPrice ? `AND s.price <= ${Number(maxPrice)}` : ""}
     ${minRating ? `AND s.rating >= ${Number(minRating)}` : ""}
     ${useGeo ? geoFilter : ""}
     ORDER BY ${useGeo ? "distance ASC NULLS LAST" : sortBy === "price" ? "s.price" : sortBy === "rating" ? "s.rating" : "s.created_at"} ${useGeo ? "" : sortOrder === "asc" ? "ASC" : "DESC"}
     LIMIT ${limit} OFFSET ${offset}`
  );

  res.json({ success: true, data: services.rows, pagination: buildPagination(page, limit, totalResult?.count ?? 0) });
}

async function getServiceById(req: Request, res: Response): Promise<void> {
  const { id } = req.params;

  const result = await pool.query(
    `SELECT s.id, s.title, s.description, s.price, s.category,
            s.vendor_id as "vendorId", s.rating, s.review_count as "reviewCount",
            s.status, s.phone, s.experience, s.license_no as "licenseNo",
            s.location, s.portfolio, s.background_check as "backgroundCheck",
            s.images, s.created_at as "createdAt",
            v.business_name as "vendorBusinessName"
     FROM services s
     LEFT JOIN vendors v ON v.id = s.vendor_id
     WHERE s.id = $1`,
    [id]
  );

  if (result.rows.length === 0) {
    res.status(404).json({ success: false, message: "Service not found" });
    return;
  }

  const row = result.rows[0];
  res.json({
    ...row,
    vendor: row.vendorBusinessName ? { id: row.vendorId, businessName: row.vendorBusinessName } : null,
  });
}

async function createService(req: AuthRequest, res: Response): Promise<void> {
  const { title, description, price, category, phone, experience, licenseNo, location, portfolio, backgroundCheck, images, lat, lng } = req.body as {
    title: string; description: string; price: number; category: string;
    phone?: string; experience?: number; licenseNo?: string;
    location?: string; portfolio?: string; backgroundCheck?: boolean;
    images?: string[]; lat?: number; lng?: number;
  };

  const [vendor] = await db
    .select()
    .from(vendorsTable)
    .where(eq(vendorsTable.userId, req.user!.id))
    .limit(1);

  if (!vendor) {
    res.status(403).json({ success: false, message: "No vendor profile found" });
    return;
  }

  const [service] = await db
    .insert(servicesTable)
    .values({
      id: generateId(), title, description, price, category,
      vendorId: vendor.id, phone, experience, licenseNo,
      location, portfolio, backgroundCheck: backgroundCheck ?? false,
      images: JSON.stringify(images ?? []),
      lat: lat ?? null,
      lng: lng ?? null,
    })
    .returning();

  res.status(201).json(service);
}

async function updateService(req: AuthRequest, res: Response): Promise<void> {
  const { id } = req.params;
  const { title, description, price, category, phone, experience, licenseNo, location, portfolio, backgroundCheck, images, lat, lng } = req.body as Record<string, any>;

  const [vendor] = await db
    .select()
    .from(vendorsTable)
    .where(eq(vendorsTable.userId, req.user!.id))
    .limit(1);

  if (!vendor) {
    res.status(403).json({ success: false, message: "No vendor profile found" });
    return;
  }

  const [service] = await db
    .select()
    .from(servicesTable)
    .where(and(eq(servicesTable.id, id), eq(servicesTable.vendorId, vendor.id)))
    .limit(1);

  if (!service) {
    res.status(404).json({ success: false, message: "Service not found" });
    return;
  }

  const updates: Record<string, unknown> = {};
  if (title !== undefined) updates.title = title;
  if (description !== undefined) updates.description = description;
  if (price !== undefined) updates.price = price;
  if (category !== undefined) updates.category = category;
  if (phone !== undefined) updates.phone = phone;
  if (experience !== undefined) updates.experience = Number(experience);
  if (licenseNo !== undefined) updates.licenseNo = licenseNo;
  if (location !== undefined) updates.location = location;
  if (portfolio !== undefined) updates.portfolio = portfolio;
  if (backgroundCheck !== undefined) updates.backgroundCheck = backgroundCheck;
  if (images !== undefined) updates.images = JSON.stringify(images);
  if (lat !== undefined) updates.lat = lat;
  if (lng !== undefined) updates.lng = lng;

  const [updated] = await db
    .update(servicesTable)
    .set(updates)
    .where(eq(servicesTable.id, id))
    .returning();

  res.json(updated);
}

async function deleteService(req: AuthRequest, res: Response): Promise<void> {
  const { id } = req.params;

  const [vendor] = await db
    .select()
    .from(vendorsTable)
    .where(eq(vendorsTable.userId, req.user!.id))
    .limit(1);

  if (!vendor) {
    res.status(403).json({ success: false, message: "No vendor profile found" });
    return;
  }

  const [service] = await db
    .select()
    .from(servicesTable)
    .where(and(eq(servicesTable.id, id), eq(servicesTable.vendorId, vendor.id)))
    .limit(1);

  if (!service) {
    res.status(404).json({ success: false, message: "Service not found" });
    return;
  }

  await db.delete(servicesTable).where(eq(servicesTable.id, id));
  res.json({ success: true, message: "Service deleted" });
}

// ── Bookings ──────────────────────────────────────────────────

async function createBooking(req: AuthRequest, res: Response): Promise<void> {
  const { serviceId, date, time, customerName, customerEmail, customerPhone, address, totalAmount, couponCode } = req.body as {
    serviceId: string; date: string; time: string;
    customerName?: string; customerEmail?: string; customerPhone?: string; address?: string;
    totalAmount?: number; couponCode?: string;
  };

  const [service] = await db
    .select()
    .from(servicesTable)
    .where(eq(servicesTable.id, serviceId))
    .limit(1);

  if (!service) {
    res.status(404).json({ success: false, message: "Service not found" });
    return;
  }

  // Get user details as fallback
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.id)).limit(1);

  const [booking] = await db
    .insert(bookingsTable)
    .values({
      id: generateId(),
      userId: req.user!.id,
      vendorId: service.vendorId,
      serviceId,
      date,
      time,
      customerName: customerName || user?.name,
      customerEmail: customerEmail || user?.email,
      customerPhone,
      address,
      totalAmount: totalAmount ?? service.price,
      couponCode: couponCode || null,
    })
    .returning();

  // Track promo code usage if applicable
  if (couponCode) {
    await trackPromoUsage(booking.id, req.user!.id, couponCode);
  }

  // Notify vendor about new booking — look up the vendor's user_id
  const userNotifyName = user?.name || customerName || "A customer";
  const [vendorRow] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, service.vendorId)).limit(1);
  const vendorUserId = vendorRow?.userId;
  if (vendorUserId) {
    await db.insert(notificationsTable).values({
      id: generateId(),
      userId: vendorUserId,
      title: "New Booking",
      message: `${userNotifyName} has booked "${service.title}" for ${date} at ${time}.`,
      type: "general",
      isRead: false,
      redirectUrl: "/vendor",
      bookingId: booking.id,
    });
  }
  sendSSENotification(service.vendorId, {
    type: "booking_confirmed",
    title: "New Booking",
    message: `New booking for "${service.title}" on ${date} at ${time}.`,
    bookingId: booking.id,
  });

  // Notify admin about new booking
  const admins = await pool.query(
    `SELECT id FROM users WHERE role = 'admin' LIMIT 5`
  );
  for (const admin of admins.rows) {
    await db.insert(notificationsTable).values({
      id: generateId(),
      userId: admin.id,
      title: "New Booking Created",
      message: `${userNotifyName} booked "${service.title}" on ${date}.`,
      type: "general",
      isRead: false,
      bookingId: booking.id,
    });
    sendSSENotification(admin.id, {
      type: "booking_confirmed",
      title: "New Booking Created",
      message: `New booking for "${service.title}".`,
      bookingId: booking.id,
    });
  }

  res.status(201).json(booking);
}

async function getMyBookings(req: AuthRequest, res: Response): Promise<void> {
  const { status } = req.query as { status?: string };
  const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);

  const userId = req.user!.id;
  const statusFilter = status ? `AND b.status = '${status}'` : "";

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM bookings b WHERE b.user_id = $1 ${statusFilter}`,
    [userId]
  );

  const result = await pool.query(
    `SELECT
        b.id, b.date, b.time, b.status, b.payment_status as "paymentStatus",
        b.address, b.customer_name as "customerName", b.customer_email as "customerEmail",
        b.customer_phone as "customerPhone", b.total_amount as "totalAmount",
        b.coupon_code as "couponCode", b.completion_photos as "completionPhotos", b.created_at as "createdAt",
        s.id as "serviceId", s.title as "serviceTitle", s.price as "servicePrice",
        s.category as "serviceCategory", s.images as "serviceImages",
        v.business_name as "vendorName", v.id as "vendorId"
     FROM bookings b
     LEFT JOIN services s ON s.id = b.service_id
     LEFT JOIN vendors v ON v.id = b.vendor_id
     WHERE b.user_id = $1 ${statusFilter}
     ORDER BY b.created_at DESC
     LIMIT ${limit} OFFSET ${offset}`,
    [userId]
  );

  const bookings = result.rows.map(b => ({
    ...b,
    total: b.totalAmount ?? b.servicePrice ?? 0,
    serviceImage: (() => {
      try {
        const imgs = b.serviceImages ? JSON.parse(b.serviceImages) : [];
        return imgs[0] || "";
      } catch { return ""; }
    })(),
    completionPhotos: (() => {
      try {
        return b.completionPhotos ? JSON.parse(b.completionPhotos) : [];
      } catch { return []; }
    })(),
  }));

  res.json({
    success: true,
    data: bookings,
    pagination: buildPagination(page, limit, Number(countResult.rows[0]?.count ?? 0)),
  });
}



async function getServiceReviews(req: Request, res: Response): Promise<void> {
  const { serviceId } = req.params;
  const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);

  const [totalResult] = await db
    .select({ count: count() })
    .from(reviewsTable)
    .where(eq(reviewsTable.serviceId, serviceId));

  const reviews = await db
    .select({
      id: reviewsTable.id,
      userId: reviewsTable.userId,
      serviceId: reviewsTable.serviceId,
      rating: reviewsTable.rating,
      comment: reviewsTable.comment,
      createdAt: reviewsTable.createdAt,
      userName: usersTable.name,
    })
    .from(reviewsTable)
    .leftJoin(usersTable, eq(reviewsTable.userId, usersTable.id))
    .where(eq(reviewsTable.serviceId, serviceId))
    .limit(limit)
    .offset(offset);

  res.json({
    success: true,
    data: reviews.map((r) => ({
      id: r.id, userId: r.userId, serviceId: r.serviceId,
      rating: r.rating, comment: r.comment, createdAt: r.createdAt,
      user: { name: r.userName ?? "Anonymous" },
    })),
    pagination: buildPagination(page, limit, totalResult?.count ?? 0),
  });
}

// ── Payments ──────────────────────────────────────────────────

async function processPayment(req: AuthRequest, res: Response): Promise<void> {
  const { bookingId, amount } = req.body as { bookingId: string; amount: number };

  const [booking] = await db
    .select()
    .from(bookingsTable)
    .where(and(eq(bookingsTable.id, bookingId), eq(bookingsTable.userId, req.user!.id)))
    .limit(1);

  if (!booking) {
    res.status(404).json({ success: false, message: "Booking not found" });
    return;
  }
  if (booking.paymentStatus === "paid") {
    res.status(400).json({ success: false, message: "Booking already paid" });
    return;
  }

  await db
    .update(bookingsTable)
    .set({ paymentStatus: "paid" })
    .where(eq(bookingsTable.id, bookingId));

  res.json({
    success: true,
    message: "Payment processed successfully",
    transactionId: generateId(),
    bookingId,
    amount,
    paymentStatus: "paid",
  });
}

// ── Admin ─────────────────────────────────────────────────────

async function adminGetUsers(req: Request, res: Response): Promise<void> {
  const { role } = req.query as { role?: string };
  const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);

  const conditions: any[] = [];
  if (role) conditions.push(eq(usersTable.role, role as any));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [totalResult] = await db.select({ count: count() }).from(usersTable).where(whereClause);
  const users = await db
    .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, role: usersTable.role, createdAt: usersTable.createdAt })
    .from(usersTable)
    .where(whereClause)
    .limit(limit)
    .offset(offset);

  res.json({ success: true, data: users, pagination: buildPagination(page, limit, totalResult?.count ?? 0) });
}

async function adminDeleteUser(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
  if (!user) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }
  await db.delete(usersTable).where(eq(usersTable.id, id));
  res.json({ success: true, message: "User deleted" });
}

async function adminGetVendors(req: Request, res: Response): Promise<void> {
  const { approved } = req.query as { approved?: string };
  const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);

  const conditions: any[] = [];
  if (approved !== undefined) conditions.push(eq(vendorsTable.isApproved, approved === "true"));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [totalResult] = await db.select({ count: count() }).from(vendorsTable).where(whereClause);

  // Join with users to get email
  const vendors = await db
    .select({
      id: vendorsTable.id,
      userId: vendorsTable.userId,
      businessName: vendorsTable.businessName,
      isApproved: vendorsTable.isApproved,
      createdAt: vendorsTable.createdAt,
      userName: usersTable.name,
      userEmail: usersTable.email,
    })
    .from(vendorsTable)
    .leftJoin(usersTable, eq(vendorsTable.userId, usersTable.id))
    .where(whereClause)
    .limit(limit)
    .offset(offset);

  res.json({ success: true, data: vendors, pagination: buildPagination(page, limit, totalResult?.count ?? 0) });
}

async function adminApproveVendor(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const { isApproved } = req.body as { isApproved: boolean };

  const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, id)).limit(1);
  if (!vendor) {
    res.status(404).json({ success: false, message: "Vendor not found" });
    return;
  }

  const [updated] = await db
    .update(vendorsTable)
    .set({ isApproved })
    .where(eq(vendorsTable.id, id))
    .returning();

  res.json(updated);
}

async function adminGetBookings(req: Request, res: Response): Promise<void> {
  const { status } = req.query as { status?: string };
  const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);

  const conditions: any[] = [];
  if (status) conditions.push(eq(bookingsTable.status, status as any));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [totalResult] = await db.select({ count: count() }).from(bookingsTable).where(whereClause);

  const bookings = await db
    .select({
      id: bookingsTable.id,
      date: bookingsTable.date,
      time: bookingsTable.time,
      status: bookingsTable.status,
      paymentStatus: bookingsTable.paymentStatus,
      address: bookingsTable.address,
      customerName: bookingsTable.customerName,
      customerEmail: bookingsTable.customerEmail,
      customerPhone: bookingsTable.customerPhone,
      totalAmount: bookingsTable.totalAmount,
      couponCode: bookingsTable.couponCode,
      completionPhotos: bookingsTable.completionPhotos,
      createdAt: bookingsTable.createdAt,
      // Customer (user) info
      userName: usersTable.name,
      userEmail: usersTable.email,
      // Service info
      serviceTitle: servicesTable.title,
      servicePrice: servicesTable.price,
      serviceCategory: servicesTable.category,
      serviceImages: servicesTable.images,
      // Vendor info
      vendorBusiness: vendorsTable.businessName,
    })
    .from(bookingsTable)
    .leftJoin(usersTable, eq(bookingsTable.userId, usersTable.id))
    .leftJoin(servicesTable, eq(bookingsTable.serviceId, servicesTable.id))
    .leftJoin(vendorsTable, eq(bookingsTable.vendorId, vendorsTable.id))
    .where(whereClause)
    .orderBy(desc(bookingsTable.createdAt))
    .limit(limit)
    .offset(offset);

  const mapped = bookings.map(b => ({
    ...b,
    serviceImage: (() => { try { const imgs = b.serviceImages ? JSON.parse(b.serviceImages) : []; return imgs[0] || ""; } catch { return ""; } })(),
  }));

  res.json({ success: true, data: mapped, pagination: buildPagination(page, limit, totalResult?.count ?? 0) });
}

async function adminGetReports(_req: Request, res: Response): Promise<void> {
  const [totalUsers] = await db.select({ count: count() }).from(usersTable);
  const [totalVendors] = await db.select({ count: count() }).from(vendorsTable);
  const [approvedVendors] = await db.select({ count: count() }).from(vendorsTable).where(eq(vendorsTable.isApproved, true));
  const [pendingVendors] = await db.select({ count: count() }).from(vendorsTable).where(eq(vendorsTable.isApproved, false));
  const [totalServices] = await db.select({ count: count() }).from(servicesTable);
  const [totalBookings] = await db.select({ count: count() }).from(bookingsTable);

  const statusGroups = await db
    .select({ status: bookingsTable.status, count: count() })
    .from(bookingsTable)
    .groupBy(bookingsTable.status);

  const bookingsByStatus = { pending: 0, confirmed: 0, completed: 0, cancelled: 0 };
  for (const row of statusGroups) {
    if (row.status in bookingsByStatus) {
      bookingsByStatus[row.status as keyof typeof bookingsByStatus] = row.count;
    }
  }

  // All bookings with totalAmount and createdAt for monthly breakdown
  const allBookings = await db
    .select({
      totalAmount: bookingsTable.totalAmount,
      serviceId: bookingsTable.serviceId,
      createdAt: bookingsTable.createdAt,
    })
    .from(bookingsTable);

  // Build monthly revenue map for the current year
  const currentYear = new Date().getFullYear();
  const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const monthlyMap: Record<number, { revenue: number; bookings: number }> = {};
  for (let i = 0; i < 12; i++) monthlyMap[i] = { revenue: 0, bookings: 0 };

  let totalRevenue = 0;
  for (const b of allBookings) {
    const date = new Date(b.createdAt);
    if (date.getFullYear() === currentYear) {
      const month = date.getMonth();
      // Use stored totalAmount, fallback to service price
      let amount = b.totalAmount ?? 0;
      if (!amount && b.serviceId) {
        const [svc] = await db.select({ price: servicesTable.price }).from(servicesTable).where(eq(servicesTable.id, b.serviceId)).limit(1);
        amount = svc?.price ?? 0;
      }
      monthlyMap[month].revenue += amount;
      monthlyMap[month].bookings += 1;
      totalRevenue += amount;
    }
  }

  const monthlyRevenue = MONTH_NAMES.map((month, i) => ({
    month,
    revenue: Math.round(monthlyMap[i].revenue),
    bookings: monthlyMap[i].bookings,
  }));

  res.json({
    success: true,
    data: {
      totalUsers: totalUsers?.count ?? 0,
      totalVendors: totalVendors?.count ?? 0,
      approvedVendors: approvedVendors?.count ?? 0,
      pendingVendors: pendingVendors?.count ?? 0,
      totalServices: totalServices?.count ?? 0,
      totalBookings: totalBookings?.count ?? 0,
      bookingsByStatus,
      totalRevenue,
      monthlyRevenue,
    },
  });
}

// ── Admin Service Approval ────────────────────────────────────

async function adminGetPendingServices(_req: Request, res: Response): Promise<void> {
  const services = await db
    .select({
      id: servicesTable.id,
      title: servicesTable.title,
      description: servicesTable.description,
      price: servicesTable.price,
      category: servicesTable.category,
      status: servicesTable.status,
      rating: servicesTable.rating,
      reviewCount: servicesTable.reviewCount,
      createdAt: servicesTable.createdAt,
      vendorId: servicesTable.vendorId,
      phone: servicesTable.phone,
      experience: servicesTable.experience,
      licenseNo: servicesTable.licenseNo,
      location: servicesTable.location,
      portfolio: servicesTable.portfolio,
      backgroundCheck: servicesTable.backgroundCheck,
      images: servicesTable.images,
      businessName: vendorsTable.businessName,
      vendorUserId: vendorsTable.userId,
      vendorName: usersTable.name,
      vendorEmail: usersTable.email,
    })
    .from(servicesTable)
    .leftJoin(vendorsTable, eq(servicesTable.vendorId, vendorsTable.id))
    .leftJoin(usersTable, eq(vendorsTable.userId, usersTable.id))
    .orderBy(desc(servicesTable.createdAt));

  res.json({ success: true, data: services });
}

async function adminApproveService(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const { status } = req.body as { status: "approved" | "rejected" };

  const [service] = await db.select().from(servicesTable).where(eq(servicesTable.id, id)).limit(1);
  if (!service) {
    res.status(404).json({ success: false, message: "Service not found" });
    return;
  }

  const [updated] = await db
    .update(servicesTable)
    .set({ status })
    .where(eq(servicesTable.id, id))
    .returning();

  // Send notification to vendor about service approval/rejection
  const [vendor] = await db
    .select({ userId: vendorsTable.userId })
    .from(vendorsTable)
    .where(eq(vendorsTable.id, service.vendorId))
    .limit(1);

  if (vendor) {
    const notifType = status === "approved" ? "service_approved" : "general";
    const notifTitle = status === "approved" ? "Service Approved" : "Service Rejected";
    const notifMsg = status === "approved"
      ? `Your service "${service.title}" has been approved and is now live on the platform.`
      : `Your service "${service.title}" has been rejected. Please check the requirements and resubmit.`;

    await db.insert(notificationsTable).values({
      id: generateId(),
      userId: vendor.userId,
      title: notifTitle,
      message: notifMsg,
      type: notifType as any,
      isRead: false,
      redirectUrl: "/vendor",
    });

    // Push SSE notification
    sendSSENotification(vendor.userId, {
      type: notifType,
      title: notifTitle,
      message: notifMsg,
    });
  }

  res.json({ success: true, data: updated });
}

// ── Vendor: get own services with status ─────────────────────

async function getVendorServices(req: AuthRequest, res: Response): Promise<void> {
  const [vendor] = await db
    .select()
    .from(vendorsTable)
    .where(eq(vendorsTable.userId, req.user!.id))
    .limit(1);

  if (!vendor) {
    res.status(404).json({ success: false, message: "Vendor profile not found" });
    return;
  }

  // Use raw query to ensure all columns including `images` are returned
  const result = await pool.query(
    `SELECT id, title, description, price, category, vendor_id as "vendorId",
            rating, review_count as "reviewCount", status, phone, experience,
            license_no as "licenseNo", location, portfolio, background_check as "backgroundCheck",
            images, created_at as "createdAt"
     FROM services WHERE vendor_id = $1 ORDER BY created_at DESC`,
    [vendor.id]
  );

  res.json({ success: true, data: result.rows });
}

// ── Customer Dashboard ────────────────────────────────────────

async function getCustomerDashboard(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;

  const [totalBookings] = await db
    .select({ count: count() })
    .from(bookingsTable)
    .where(eq(bookingsTable.userId, userId));

  const statusGroups = await db
    .select({ status: bookingsTable.status, count: count() })
    .from(bookingsTable)
    .where(eq(bookingsTable.userId, userId))
    .groupBy(bookingsTable.status);

  const bookingsByStatus: Record<string, number> = { pending: 0, confirmed: 0, completed: 0, cancelled: 0 };
  for (const row of statusGroups) {
    bookingsByStatus[row.status as string] = row.count;
  }

  // Get active promo codes
  const now = new Date();
  const activePromos = await db
    .select()
    .from(promoCodesTable)
    .where(and(eq(promoCodesTable.isActive, true), gte(promoCodesTable.validUntil, now)))
    .limit(5);

  // Get pending reviews (completed bookings without review)
  const completedBookings = await db
    .select({ id: bookingsTable.id, serviceId: bookingsTable.serviceId, title: servicesTable.title })
    .from(bookingsTable)
    .leftJoin(servicesTable, eq(bookingsTable.serviceId, servicesTable.id))
    .where(and(eq(bookingsTable.userId, userId), eq(bookingsTable.status, "completed")))
    .limit(50);

  const reviewedBookingIds = await db
    .select({ bookingId: reviewsTable.bookingId })
    .from(reviewsTable)
    .where(eq(reviewsTable.userId, userId));

  const reviewedSet = new Set(reviewedBookingIds.map(r => r.bookingId));
  const pendingReviews = completedBookings.filter(b => !reviewedSet.has(b.id));

  // Get unread notification count
  const [unreadCount] = await db
    .select({ count: count() })
    .from(notificationsTable)
    .where(and(eq(notificationsTable.userId, userId), eq(notificationsTable.isRead, false)));

  res.json({
    success: true,
    data: {
      totalBookings: totalBookings?.count ?? 0,
      bookingsByStatus,
      upcomingBookings: bookingsByStatus["confirmed"] ?? 0,
      activeBookings: (bookingsByStatus["pending"] ?? 0) + (bookingsByStatus["confirmed"] ?? 0),
      completedServices: bookingsByStatus["completed"] ?? 0,
      availablePromoCodes: activePromos.map(p => ({
        id: p.id, code: p.code, title: p.title,
        discountType: p.discountType, discountValue: p.discountValue,
        maxDiscount: p.maxDiscount, minBookingAmount: p.minBookingAmount,
        validUntil: p.validUntil, category: p.category,
      })),
      pendingReviews: pendingReviews.length,
      unreadNotifications: unreadCount?.count ?? 0,
    },
  });
}

// ── Promo Codes ───────────────────────────────────────────────

async function validatePromoCode(req: AuthRequest, res: Response): Promise<void> {
  const { code } = req.params;
  const { serviceId, amount } = req.query as { serviceId?: string; amount?: string };

  const [promo] = await db
    .select()
    .from(promoCodesTable)
    .where(and(eq(promoCodesTable.code, code.toUpperCase()), eq(promoCodesTable.isActive, true)))
    .limit(1);

  if (!promo) {
    res.status(404).json({ success: false, message: "Invalid promo code" });
    return;
  }

  // Check expiry
  if (new Date() > new Date(promo.validUntil)) {
    res.status(400).json({ success: false, message: "Promo code has expired" });
    return;
  }

  // Check minimum amount
  const bookingAmount = amount ? Number(amount) : 0;
  if (promo.minBookingAmount && bookingAmount < promo.minBookingAmount) {
    res.status(400).json({
      success: false,
      message: `Minimum booking amount of ₹${promo.minBookingAmount} required`,
    });
    return;
  }

  // Check first-time only
  const [userBookings] = await db
    .select({ count: count() })
    .from(bookingsTable)
    .where(eq(bookingsTable.userId, req.user!.id));

  if (promo.firstTimeOnly && (userBookings?.count ?? 0) > 0) {
    res.status(400).json({ success: false, message: "This promo is for first-time users only" });
    return;
  }

  // Check usage
  const usageRecords = await db
    .select()
    .from(promoUsageTable)
    .where(and(eq(promoUsageTable.userId, req.user!.id), eq(promoUsageTable.promoCodeId, promo.id)))
    .orderBy(desc(promoUsageTable.createdAt));

  // Check one-time per user
  if (promo.oneTimePerUser && usageRecords.length > 0) {
    // Allow reuse if last usage is eligible for reuse
    const lastUsage = usageRecords[0];
    if (lastUsage && !lastUsage.eligibleForReuse) {
      res.status(400).json({
        success: false,
        message: "You can reuse this promo code after the previous service is completed.",
        reuseEligible: false,
      });
      return;
    }
  }

  // Calculate discount
  let discountAmount = 0;
  if (promo.discountType === "percent") {
    discountAmount = (bookingAmount * promo.discountValue) / 100;
    if (promo.maxDiscount && discountAmount > promo.maxDiscount) {
      discountAmount = promo.maxDiscount;
    }
  } else {
    discountAmount = promo.discountValue;
  }

  res.json({
    success: true,
    data: {
      id: promo.id,
      code: promo.code,
      title: promo.title,
      description: promo.description,
      discountType: promo.discountType,
      discountValue: promo.discountValue,
      discountAmount: Math.round(discountAmount),
      maxDiscount: promo.maxDiscount,
      category: promo.category,
      validUntil: promo.validUntil,
    },
  });
}

async function getActivePromoCodes(_req: Request, res: Response): Promise<void> {
  const now = new Date();
  const promos = await db
    .select()
    .from(promoCodesTable)
    .where(and(eq(promoCodesTable.isActive, true), gte(promoCodesTable.validUntil, now)))
    .orderBy(desc(promoCodesTable.createdAt));

  res.json({ success: true, data: promos });
}

async function getMyPromoUsage(req: AuthRequest, res: Response): Promise<void> {
  const usage = await db
    .select({
      id: promoUsageTable.id,
      usedAt: promoUsageTable.usedAt,
      bookingStatus: promoUsageTable.bookingStatus,
      eligibleForReuse: promoUsageTable.eligibleForReuse,
      promoCode: promoCodesTable.code,
      promoTitle: promoCodesTable.title,
      bookingId: promoUsageTable.bookingId,
    })
    .from(promoUsageTable)
    .leftJoin(promoCodesTable, eq(promoUsageTable.promoCodeId, promoCodesTable.id))
    .where(eq(promoUsageTable.userId, req.user!.id))
    .orderBy(desc(promoUsageTable.createdAt));

  res.json({ success: true, data: usage });
}

// ── Admin Promo Code Management ───────────────────────────────

async function adminGetPromoCodes(_req: Request, res: Response): Promise<void> {
  const promos = await db
    .select()
    .from(promoCodesTable)
    .orderBy(desc(promoCodesTable.createdAt));

  res.json({ success: true, data: promos });
}

async function adminCreatePromoCode(req: Request, res: Response): Promise<void> {
  const { code, title, description, discountType, discountValue, minBookingAmount, maxDiscount, validUntil, category, firstTimeOnly, oneTimePerUser } = req.body;

  // Check duplicate code
  const [existing] = await db.select().from(promoCodesTable).where(eq(promoCodesTable.code, code.toUpperCase())).limit(1);
  if (existing) {
    res.status(400).json({ success: false, message: "Promo code already exists" });
    return;
  }

  const [promo] = await db
    .insert(promoCodesTable)
    .values({
      id: generateId(),
      code: code.toUpperCase(),
      title,
      description,
      discountType,
      discountValue,
      minBookingAmount: minBookingAmount || 0,
      maxDiscount: maxDiscount || null,
      validUntil: new Date(validUntil),
      category: category || "all",
      firstTimeOnly: firstTimeOnly || false,
      oneTimePerUser: oneTimePerUser || false,
    })
    .returning();

  res.status(201).json({ success: true, data: promo });
}

async function adminUpdatePromoCode(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const updates = req.body;

  const [existing] = await db.select().from(promoCodesTable).where(eq(promoCodesTable.id, id)).limit(1);
  if (!existing) {
    res.status(404).json({ success: false, message: "Promo code not found" });
    return;
  }

  const updateData: Record<string, unknown> = {};
  if (updates.title !== undefined) updateData.title = updates.title;
  if (updates.description !== undefined) updateData.description = updates.description;
  if (updates.discountType !== undefined) updateData.discountType = updates.discountType;
  if (updates.discountValue !== undefined) updateData.discountValue = updates.discountValue;
  if (updates.minBookingAmount !== undefined) updateData.minBookingAmount = updates.minBookingAmount;
  if (updates.maxDiscount !== undefined) updateData.maxDiscount = updates.maxDiscount;
  if (updates.validUntil !== undefined) updateData.validUntil = new Date(updates.validUntil);
  if (updates.category !== undefined) updateData.category = updates.category;
  if (updates.firstTimeOnly !== undefined) updateData.firstTimeOnly = updates.firstTimeOnly;
  if (updates.oneTimePerUser !== undefined) updateData.oneTimePerUser = updates.oneTimePerUser;
  if (updates.isActive !== undefined) updateData.isActive = updates.isActive;
  if (updates.code !== undefined) updateData.code = updates.code.toUpperCase();

  const [updated] = await db
    .update(promoCodesTable)
    .set(updateData)
    .where(eq(promoCodesTable.id, id))
    .returning();

  res.json({ success: true, data: updated });
}

async function adminDeletePromoCode(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const [existing] = await db.select().from(promoCodesTable).where(eq(promoCodesTable.id, id)).limit(1);
  if (!existing) {
    res.status(404).json({ success: false, message: "Promo code not found" });
    return;
  }
  await db.delete(promoCodesTable).where(eq(promoCodesTable.id, id));
  res.json({ success: true, message: "Promo code deleted" });
}

// ── Notifications ─────────────────────────────────────────────

async function getMyNotifications(req: AuthRequest, res: Response): Promise<void> {
  const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);

  const [totalResult] = await db
    .select({ count: count() })
    .from(notificationsTable)
    .where(eq(notificationsTable.userId, req.user!.id));

  const notifications = await db
    .select()
    .from(notificationsTable)
    .where(eq(notificationsTable.userId, req.user!.id))
    .orderBy(desc(notificationsTable.createdAt))
    .limit(limit)
    .offset(offset);

  res.json({
    success: true,
    data: notifications,
    pagination: buildPagination(page, limit, totalResult?.count ?? 0),
  });
}

async function getUnreadNotificationCount(req: AuthRequest, res: Response): Promise<void> {
  const [result] = await db
    .select({ count: count() })
    .from(notificationsTable)
    .where(and(eq(notificationsTable.userId, req.user!.id), eq(notificationsTable.isRead, false)));

  res.json({ success: true, count: result?.count ?? 0 });
}

async function markNotificationRead(req: AuthRequest, res: Response): Promise<void> {
  const { id } = req.params;
  await db
    .update(notificationsTable)
    .set({ isRead: true })
    .where(and(eq(notificationsTable.id, id), eq(notificationsTable.userId, req.user!.id)));

  res.json({ success: true });
}

async function markAllNotificationsRead(req: AuthRequest, res: Response): Promise<void> {
  await db
    .update(notificationsTable)
    .set({ isRead: true })
    .where(eq(notificationsTable.userId, req.user!.id));

  res.json({ success: true });
}

// ── SSE (Server-Sent Events) for Real-Time Notifications ──────────────

const sseClients = new Map<string, Set<Response>>();

function addSSEClient(userId: string, res: Response) {
  if (!sseClients.has(userId)) {
    sseClients.set(userId, new Set());
  }
  sseClients.get(userId)!.add(res);
  res.on("close", () => {
    sseClients.get(userId)?.delete(res);
    if (sseClients.get(userId)?.size === 0) {
      sseClients.delete(userId);
    }
  });
}

function sendSSENotification(userId: string, data: object) {
  const clients = sseClients.get(userId);
  if (!clients) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

async function sseHandler(req: AuthRequest, res: Response): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("data: {\"type\":\"connected\"}\n\n");
  addSSEClient(req.user!.id, res);
}

// ── Reviews (enhanced) ────────────────────────────────────────

async function createReview(req: AuthRequest, res: Response): Promise<void> {
  const { bookingId, rating, comment, title } = req.body as {
    bookingId: string; rating: number; comment: string; title?: string;
  };

  // Verify booking exists, is completed, and belongs to user
  const [booking] = await db
    .select()
    .from(bookingsTable)
    .where(and(eq(bookingsTable.id, bookingId), eq(bookingsTable.userId, req.user!.id)))
    .limit(1);

  if (!booking) {
    res.status(404).json({ success: false, message: "Booking not found" });
    return;
  }

  if (booking.status !== "completed") {
    res.status(400).json({ success: false, message: "You can only review completed services" });
    return;
  }

  // Check duplicate review
  const [existing] = await db
    .select()
    .from(reviewsTable)
    .where(and(eq(reviewsTable.bookingId, bookingId), eq(reviewsTable.userId, req.user!.id)))
    .limit(1);

  if (existing) {
    res.status(400).json({ success: false, message: "You have already reviewed this booking" });
    return;
  }

  const [service] = await db
    .select()
    .from(servicesTable)
    .where(eq(servicesTable.id, booking.serviceId))
    .limit(1);

  if (!service) {
    res.status(404).json({ success: false, message: "Service not found" });
    return;
  }

  const [review] = await db
    .insert(reviewsTable)
    .values({
      id: generateId(),
      userId: req.user!.id,
      serviceId: booking.serviceId,
      bookingId,
      vendorId: booking.vendorId,
      rating,
      title: title || "",
      comment,
    })
    .returning();

  // Update service rating stats
  const [stats] = await db
    .select({ avg: avg(reviewsTable.rating), count: count() })
    .from(reviewsTable)
    .where(eq(reviewsTable.serviceId, booking.serviceId));

  await db
    .update(servicesTable)
    .set({ rating: Number(Number(stats?.avg ?? 0).toFixed(2)), reviewCount: stats?.count ?? 0 })
    .where(eq(servicesTable.id, booking.serviceId));

  const [user] = await db
    .select({ name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.id, req.user!.id))
    .limit(1);

  // Notify vendor about new review
  const reviewerName = user?.name || "A customer";
  await db.insert(notificationsTable).values({
    id: generateId(),
    userId: booking.vendorId,
    title: "New Review",
    message: `${reviewerName} left a ${rating}-star review for "${service.title}".`,
    type: "general",
    isRead: false,
    redirectUrl: "/vendor/reviews",
    bookingId: booking.id,
  });
  sendSSENotification(booking.vendorId, {
    type: "review_request",
    title: "New Review",
    message: `New ${rating}-star review for "${service.title}".`,
    bookingId: booking.id,
    redirectUrl: "/vendor/reviews",
  });

  res.status(201).json({ ...review, user: { name: reviewerName } });
}

async function updateReview(req: AuthRequest, res: Response): Promise<void> {
  const { id } = req.params;
  const { rating, comment, title } = req.body as { rating?: number; comment?: string; title?: string };

  const [review] = await db
    .select()
    .from(reviewsTable)
    .where(and(eq(reviewsTable.id, id), eq(reviewsTable.userId, req.user!.id)))
    .limit(1);

  if (!review) {
    res.status(404).json({ success: false, message: "Review not found" });
    return;
  }

  const updates: Record<string, unknown> = {};
  if (rating !== undefined) updates.rating = rating;
  if (comment !== undefined) updates.comment = comment;
  if (title !== undefined) updates.title = title;

  const [updated] = await db
    .update(reviewsTable)
    .set(updates)
    .where(eq(reviewsTable.id, id))
    .returning();

  // Recalculate service rating
  const [stats] = await db
    .select({ avg: avg(reviewsTable.rating), count: count() })
    .from(reviewsTable)
    .where(eq(reviewsTable.serviceId, review.serviceId));

  await db
    .update(servicesTable)
    .set({ rating: Number(Number(stats?.avg ?? 0).toFixed(2)), reviewCount: stats?.count ?? 0 })
    .where(eq(servicesTable.id, review.serviceId));

  res.json({ success: true, data: updated });
}

async function deleteReview(req: AuthRequest, res: Response): Promise<void> {
  const { id } = req.params;

  const [review] = await db
    .select()
    .from(reviewsTable)
    .where(and(eq(reviewsTable.id, id), eq(reviewsTable.userId, req.user!.id)))
    .limit(1);

  if (!review) {
    res.status(404).json({ success: false, message: "Review not found" });
    return;
  }

  await db.delete(reviewsTable).where(eq(reviewsTable.id, id));

  // Recalculate service rating
  const [stats] = await db
    .select({ avg: avg(reviewsTable.rating), count: count() })
    .from(reviewsTable)
    .where(eq(reviewsTable.serviceId, review.serviceId));

  await db
    .update(servicesTable)
    .set({ rating: Number(Number(stats?.avg ?? 0).toFixed(2)), reviewCount: stats?.count ?? 0 })
    .where(eq(servicesTable.id, review.serviceId));

  res.json({ success: true, message: "Review deleted" });
}

async function getMyReviews(req: AuthRequest, res: Response): Promise<void> {
  const reviews = await db
    .select({
      id: reviewsTable.id,
      bookingId: reviewsTable.bookingId,
      serviceId: reviewsTable.serviceId,
      rating: reviewsTable.rating,
      title: reviewsTable.title,
      comment: reviewsTable.comment,
      createdAt: reviewsTable.createdAt,
      serviceTitle: servicesTable.title,
    })
    .from(reviewsTable)
    .leftJoin(servicesTable, eq(reviewsTable.serviceId, servicesTable.id))
    .where(eq(reviewsTable.userId, req.user!.id))
    .orderBy(desc(reviewsTable.createdAt));

  res.json({ success: true, data: reviews });
}

// ── Vendor Reviews ────────────────────────────────────────────

async function getVendorReviews(req: AuthRequest, res: Response): Promise<void> {
  const [vendor] = await db
    .select()
    .from(vendorsTable)
    .where(eq(vendorsTable.userId, req.user!.id))
    .limit(1);

  if (!vendor) {
    res.status(404).json({ success: false, message: "Vendor profile not found" });
    return;
  }

  const reviews = await db
    .select({
      id: reviewsTable.id,
      rating: reviewsTable.rating,
      title: reviewsTable.title,
      comment: reviewsTable.comment,
      createdAt: reviewsTable.createdAt,
      serviceTitle: servicesTable.title,
      serviceId: servicesTable.id,
      userName: usersTable.name,
    })
    .from(reviewsTable)
    .leftJoin(servicesTable, eq(reviewsTable.serviceId, servicesTable.id))
    .leftJoin(usersTable, eq(reviewsTable.userId, usersTable.id))
    .where(eq(reviewsTable.vendorId, vendor.id))
    .orderBy(desc(reviewsTable.createdAt));

  // Calculate average rating
  const [stats] = await db
    .select({ avg: avg(reviewsTable.rating), count: count() })
    .from(reviewsTable)
    .where(eq(reviewsTable.vendorId, vendor.id));

  res.json({
    success: true,
    data: {
      reviews,
      averageRating: Number(Number(stats?.avg ?? 0).toFixed(1)),
      totalReviews: stats?.count ?? 0,
    },
  });
}

// ── Admin Review Moderation ───────────────────────────────────

async function adminGetAllReviews(_req: Request, res: Response): Promise<void> {
  const reviews = await db
    .select({
      id: reviewsTable.id,
      rating: reviewsTable.rating,
      title: reviewsTable.title,
      comment: reviewsTable.comment,
      createdAt: reviewsTable.createdAt,
      serviceTitle: servicesTable.title,
      userName: usersTable.name,
      userEmail: usersTable.email,
    })
    .from(reviewsTable)
    .leftJoin(servicesTable, eq(reviewsTable.serviceId, servicesTable.id))
    .leftJoin(usersTable, eq(reviewsTable.userId, usersTable.id))
    .orderBy(desc(reviewsTable.createdAt));

  res.json({ success: true, data: reviews });
}

async function adminDeleteReview(req: Request, res: Response): Promise<void> {
  const { id } = req.params;

  const [review] = await db.select().from(reviewsTable).where(eq(reviewsTable.id, id)).limit(1);
  if (!review) {
    res.status(404).json({ success: false, message: "Review not found" });
    return;
  }

  await db.delete(reviewsTable).where(eq(reviewsTable.id, id));

  // Recalculate service rating
  const [stats] = await db
    .select({ avg: avg(reviewsTable.rating), count: count() })
    .from(reviewsTable)
    .where(eq(reviewsTable.serviceId, review.serviceId));

  await db
    .update(servicesTable)
    .set({ rating: Number(Number(stats?.avg ?? 0).toFixed(2)), reviewCount: stats?.count ?? 0 })
    .where(eq(servicesTable.id, review.serviceId));

  res.json({ success: true, message: "Review deleted" });
}

// ── Enhanced Vendor Booking Completion ───────────────────────

async function updateVendorBooking(req: AuthRequest, res: Response): Promise<void> {
  const { id } = req.params;
  const { status } = req.body as { status: "confirmed" | "completed" | "cancelled" };

  const [vendor] = await db
    .select()
    .from(vendorsTable)
    .where(eq(vendorsTable.userId, req.user!.id))
    .limit(1);

  if (!vendor) {
    res.status(404).json({ success: false, message: "Vendor profile not found" });
    return;
  }

  const [booking] = await db
    .select()
    .from(bookingsTable)
    .where(and(eq(bookingsTable.id, id), eq(bookingsTable.vendorId, vendor.id)))
    .limit(1);

  if (!booking) {
    res.status(404).json({ success: false, message: "Booking not found" });
    return;
  }

  const [updated] = await db
    .update(bookingsTable)
    .set({ status })
    .where(eq(bookingsTable.id, id))
    .returning();

  // If completed — trigger notifications and promo eligibility
  if (status === "completed") {
    // Create notification for the customer
    const serviceResult = await pool.query(
      `SELECT title FROM services WHERE id = $1`,
      [booking.serviceId]
    );
    const serviceTitle = serviceResult.rows[0]?.title || "Service";

    await db.insert(notificationsTable).values({
      id: generateId(),
      userId: booking.userId,
      title: "Service Completed",
      message: `Your service "${serviceTitle}" has been completed. Please share your experience by leaving a review.`,
      type: "booking_completed",
      isRead: false,
      redirectUrl: `/user/my-bookings?booking=${booking.id}&action=review`,
      bookingId: booking.id,
    });

    // SSE: Push real-time notification to customer
    sendSSENotification(booking.userId, {
      type: "booking_completed",
      message: `Service "${serviceTitle}" completed. Please leave a review.`,
      redirectUrl: `/user/my-bookings?booking=${booking.id}&action=review`,
      bookingId: booking.id,
    });

    // Update promo eligibility — mark promo_usage records as eligible for reuse
    if (booking.couponCode) {
      const [promo] = await db
        .select()
        .from(promoCodesTable)
        .where(eq(promoCodesTable.code, booking.couponCode))
        .limit(1);

      if (promo) {
        await db
          .update(promoUsageTable)
          .set({
            bookingStatus: "completed",
            eligibleForReuse: true,
            updatedAt: new Date(),
          })
          .where(and(eq(promoUsageTable.bookingId, booking.id), eq(promoUsageTable.promoCodeId, promo.id)));
      }
    }

    // Notification for the vendor
    const vendorNotifId = generateId();
    await db.insert(notificationsTable).values({
      id: vendorNotifId,
      userId: booking.vendorId,
      title: "Booking Completed",
      message: `Booking for "${serviceTitle}" has been marked as completed successfully.`,
      type: "general",
      isRead: false,
      redirectUrl: `/vendor/bookings`,
      bookingId: booking.id,
    });
    sendSSENotification(booking.vendorId, {
      type: "booking_completed",
      message: `Booking for "${serviceTitle}" completed successfully.`,
      bookingId: booking.id,
    });

    // Notification for admin
    // Find admin user(s) to notify
    const admins = await pool.query(
      `SELECT id FROM users WHERE role = 'admin' LIMIT 5`
    );
    for (const admin of admins.rows) {
      const adminNotifId = generateId();
      await db.insert(notificationsTable).values({
        id: adminNotifId,
        userId: admin.id,
        title: "Booking Completed by Vendor",
        message: `Booking for "${serviceTitle}" has been completed by the vendor.`,
        type: "general",
        isRead: false,
        bookingId: booking.id,
      });
      sendSSENotification(admin.id, {
        type: "booking_completed",
        message: `Booking for "${serviceTitle}" completed by vendor.`,
        bookingId: booking.id,
      });
    }
  }

  res.json(updated);
}

// ── Helper: Track promo usage on booking creation ────────────

async function trackPromoUsage(bookingId: string, userId: string, couponCode: string): Promise<void> {
  const [promo] = await db
    .select()
    .from(promoCodesTable)
    .where(eq(promoCodesTable.code, couponCode))
    .limit(1);

  if (!promo) return;

  // Check existing usage for this user + promo
  const existingUsage = await db
    .select()
    .from(promoUsageTable)
    .where(and(eq(promoUsageTable.userId, userId), eq(promoUsageTable.promoCodeId, promo.id), eq(promoUsageTable.eligibleForReuse, true)))
    .limit(1);

  if (existingUsage.length > 0) {
    // Reusing — update existing record
    await db
      .update(promoUsageTable)
      .set({
        bookingId,
        usedAt: new Date(),
        bookingStatus: "pending",
        eligibleForReuse: false,
        reuseCount: (existingUsage[0].reuseCount ?? 0) + 1,
        updatedAt: new Date(),
      })
      .where(eq(promoUsageTable.id, existingUsage[0].id));
  } else {
    // New usage
    await db.insert(promoUsageTable).values({
      id: generateId(),
      userId,
      bookingId,
      promoCodeId: promo.id,
      bookingStatus: "pending",
      eligibleForReuse: false,
    });
  }

  // Increment promo code usage count
  await db
    .update(promoCodesTable)
    .set({ usageCount: (promo.usageCount ?? 0) + 1 })
    .where(eq(promoCodesTable.id, promo.id));
}

// ============================================================
// SECTION 8 — ROUTES
// ============================================================

const router = Router();

// Health
router.get("/healthz", (_req, res) => res.json({ status: "ok" }));

// Debug database connection
router.get("/debug/db", async (_req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query("SELECT 1 as connected");
    client.release();
    const tables = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    );
    res.json({
      connected: true,
      tables: tables.rows.map((r: any) => r.table_name),
      env: { NODE_ENV: process.env.NODE_ENV, hasDB: !!process.env.DATABASE_URL },
    });
  } catch (err: any) {
    res.json({ connected: false, error: err.message, code: err.code });
  }
});

// Auth
router.post(
  "/auth/register",
  [
    body("name").trim().notEmpty().withMessage("Name is required"),
    body("email").isEmail().normalizeEmail().withMessage("Valid email is required"),
    body("password").isLength({ min: 6 }).withMessage("Password must be at least 6 characters"),
  ],
  validate,
  registerCustomer,
);

router.post(
  "/auth/login",
  [
    body("email").isEmail().normalizeEmail().withMessage("Valid email is required"),
    body("password").notEmpty().withMessage("Password is required"),
  ],
  validate,
  login,
);

router.get("/users/profile", authenticate, getUserProfile);

router.post(
  "/auth/verify-otp",
  [
    body("email").isEmail().normalizeEmail().withMessage("Valid email is required"),
    body("otp").isLength({ min: 6, max: 6 }).withMessage("OTP must be 6 digits"),
  ],
  validate,
  verifyOtp,
);

router.post(
  "/auth/resend-otp",
  [body("email").isEmail().normalizeEmail().withMessage("Valid email is required")],
  validate,
  resendOtp,
);

router.post(
  "/auth/send-login-otp",
  [body("email").isEmail().normalizeEmail().withMessage("Valid email is required")],
  validate,
  sendLoginOtp,
);

router.post(
  "/auth/verify-login-otp",
  [
    body("email").isEmail().normalizeEmail().withMessage("Valid email is required"),
    body("otp").isLength({ min: 6, max: 6 }).withMessage("OTP must be 6 digits"),
  ],
  validate,
  verifyLoginOtp,
);

// Vendor
router.post(
  "/vendor/register",
  [
    body("name").trim().notEmpty().withMessage("Name is required"),
    body("email").isEmail().normalizeEmail().withMessage("Valid email is required"),
    body("password").isLength({ min: 6 }).withMessage("Password must be at least 6 characters"),
    body("businessName").trim().notEmpty().withMessage("Business name is required"),
  ],
  validate,
  registerVendor,
);

router.post(
  "/vendor/login",
  [
    body("email").isEmail().normalizeEmail().withMessage("Valid email is required"),
    body("password").notEmpty().withMessage("Password is required"),
  ],
  validate,
  vendorLogin,
);

router.get("/vendor/dashboard", authenticate, requireRole("vendor"), getVendorDashboard);
router.get("/vendor/bookings", authenticate, requireRole("vendor"), getVendorBookings);
router.patch(
  "/vendor/bookings/:id",
  authenticate,
  requireRole("vendor"),
  [body("status").isIn(["confirmed", "completed", "cancelled"]).withMessage("Invalid status")],
  validate,
  updateVendorBooking,
);

// Vendor upload completion photos for a booking
router.post(
  "/vendor/bookings/:id/photos",
  authenticate,
  requireRole("vendor"),
  async (req: AuthRequest, res: Response): Promise<void> => {
    const { id } = req.params;
    const { images } = req.body as { images: string[] };

    if (!images || !Array.isArray(images) || images.length === 0) {
      res.status(400).json({ success: false, message: "images array is required" });
      return;
    }
    if (images.length > 5) {
      res.status(400).json({ success: false, message: "Maximum 5 photos allowed" });
      return;
    }

    const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.userId, req.user!.id)).limit(1);
    if (!vendor) { res.status(403).json({ success: false, message: "No vendor profile" }); return; }

    const [booking] = await db
      .select()
      .from(bookingsTable)
      .where(and(eq(bookingsTable.id, id), eq(bookingsTable.vendorId, vendor.id)))
      .limit(1);
    if (!booking) { res.status(404).json({ success: false, message: "Booking not found" }); return; }

    const [updated] = await db
      .update(bookingsTable)
      .set({ completionPhotos: JSON.stringify(images) })
      .where(eq(bookingsTable.id, id))
      .returning();

    res.json({ success: true, data: updated });
  },
);

// Services
router.get("/services", getServices);
router.get("/services/:id", getServiceById);

router.post(
  "/services",
  authenticate,
  requireRole("vendor"),
  [
    body("title").trim().notEmpty().withMessage("Title is required"),
    body("description").trim().notEmpty().withMessage("Description is required"),
    body("price").isFloat({ min: 0 }).withMessage("Price must be a positive number"),
    body("category").trim().notEmpty().withMessage("Category is required"),
  ],
  validate,
  createService,
);

router.put(
  "/services/:id",
  authenticate,
  requireRole("vendor"),
  [body("price").optional().isFloat({ min: 0 }).withMessage("Price must be a positive number")],
  validate,
  updateService,
);

router.delete("/services/:id", authenticate, requireRole("vendor"), deleteService);

// Vendor upload work photos for a service
router.post("/services/:id/photos", authenticate, requireRole("vendor"), async (req: AuthRequest, res: Response): Promise<void> => {
  const { id } = req.params;
  const { images } = req.body as { images: string[] };

  if (!images || !Array.isArray(images)) {
    res.status(400).json({ success: false, message: "images array is required" });
    return;
  }
  if (images.length > 5) {
    res.status(400).json({ success: false, message: "Maximum 5 photos allowed per service" });
    return;
  }

  const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.userId, req.user!.id)).limit(1);
  if (!vendor) { res.status(403).json({ success: false, message: "No vendor profile" }); return; }

  const [service] = await db.select().from(servicesTable)
    .where(and(eq(servicesTable.id, id), eq(servicesTable.vendorId, vendor.id))).limit(1);
  if (!service) { res.status(404).json({ success: false, message: "Service not found" }); return; }

  const [updated] = await db.update(servicesTable)
    .set({ images: JSON.stringify(images) })
    .where(eq(servicesTable.id, id))
    .returning();

  res.json({ success: true, data: updated });
});

// Admin delete service (separate from vendor delete — no vendor profile check)
router.delete("/admin/services/:id", authenticate, requireRole("admin"), async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const [service] = await db.select().from(servicesTable).where(eq(servicesTable.id, id)).limit(1);
  if (!service) { res.status(404).json({ success: false, message: "Service not found" }); return; }
  await db.delete(servicesTable).where(eq(servicesTable.id, id));
  res.json({ success: true, message: "Service deleted" });
});

// Bookings
router.get("/bookings/my", authenticate, getMyBookings);

router.post(
  "/bookings",
  authenticate,
  requireRole("customer"),
  [
    body("serviceId").notEmpty().withMessage("Service ID is required"),
    body("date").notEmpty().withMessage("Date is required"),
    body("time").notEmpty().withMessage("Time is required"),
  ],
  validate,
  createBooking,
);



// Payments
router.post(
  "/payments/checkout",
  authenticate,
  [
    body("bookingId").notEmpty().withMessage("Booking ID is required"),
    body("amount").isFloat({ min: 0 }).withMessage("Amount must be a positive number"),
  ],
  validate,
  processPayment,
);

// Admin (all routes require admin role)
router.get("/admin/users", authenticate, requireRole("admin"), adminGetUsers);
router.delete("/admin/users/:id", authenticate, requireRole("admin"), adminDeleteUser);
router.get("/admin/vendors", authenticate, requireRole("admin"), adminGetVendors);
router.patch(
  "/admin/vendors/:id/approve",
  authenticate,
  requireRole("admin"),
  [body("isApproved").isBoolean().withMessage("isApproved must be a boolean")],
  validate,
  adminApproveVendor,
);
router.get("/admin/bookings", authenticate, requireRole("admin"), adminGetBookings);
router.get("/admin/reports", authenticate, requireRole("admin"), adminGetReports);
router.get("/admin/services", authenticate, requireRole("admin"), adminGetPendingServices);
router.get("/admin/vendors/:id/services", authenticate, requireRole("admin"), async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const services = await db
    .select()
    .from(servicesTable)
    .where(and(eq(servicesTable.vendorId, id), eq(servicesTable.status, "approved")))
    .orderBy(desc(servicesTable.createdAt));
  res.json({ success: true, data: services });
});
router.patch(
  "/admin/services/:id/approve",
  authenticate,
  requireRole("admin"),
  [body("status").isIn(["approved", "rejected"]).withMessage("Status must be approved or rejected")],
  validate,
  adminApproveService,
);
router.get("/vendor/services", authenticate, requireRole("vendor"), getVendorServices);
router.get("/vendor/reviews", authenticate, requireRole("vendor"), getVendorReviews);

// Customer Dashboard
router.get("/user/dashboard", authenticate, requireRole("customer"), getCustomerDashboard);

// Promo Codes (public)
router.get("/promo-codes", getActivePromoCodes);
router.get("/promo-codes/validate/:code", authenticate, validatePromoCode);
router.get("/promo-codes/my-usage", authenticate, getMyPromoUsage);

// Admin Promo Code Management
router.get("/admin/promo-codes", authenticate, requireRole("admin"), adminGetPromoCodes);
router.post(
  "/admin/promo-codes",
  authenticate,
  requireRole("admin"),
  [
    body("code").trim().notEmpty().withMessage("Code is required"),
    body("title").trim().notEmpty().withMessage("Title is required"),
    body("description").trim().notEmpty().withMessage("Description is required"),
    body("discountType").isIn(["percent", "flat"]).withMessage("Discount type must be percent or flat"),
    body("discountValue").isFloat({ min: 0 }).withMessage("Discount value must be positive"),
    body("validUntil").notEmpty().withMessage("Valid until date is required"),
  ],
  validate,
  adminCreatePromoCode,
);
router.put("/admin/promo-codes/:id", authenticate, requireRole("admin"), adminUpdatePromoCode);
router.delete("/admin/promo-codes/:id", authenticate, requireRole("admin"), adminDeletePromoCode);

// Notifications
router.get("/notifications", authenticate, getMyNotifications);
router.get("/notifications/count", authenticate, getUnreadNotificationCount);
router.patch("/notifications/:id/read", authenticate, markNotificationRead);
router.post("/notifications/read-all", authenticate, markAllNotificationsRead);

// SSE for Real-Time Notifications
router.get("/notifications/sse", authenticate, sseHandler);

// Reviews (enhanced)
router.post(
  "/reviews",
  authenticate,
  [
    body("bookingId").notEmpty().withMessage("Booking ID is required"),
    body("rating").isFloat({ min: 1, max: 5 }).withMessage("Rating must be between 1 and 5"),
    body("comment").trim().notEmpty().withMessage("Comment is required"),
  ],
  validate,
  createReview,
);
router.get("/reviews/service/:serviceId", getServiceReviews);
router.put("/reviews/:id", authenticate, updateReview);
router.delete("/reviews/:id", authenticate, deleteReview);
router.get("/reviews/my", authenticate, getMyReviews);

// Admin Review Moderation
router.get("/admin/reviews", authenticate, requireRole("admin"), adminGetAllReviews);
router.delete("/admin/reviews/:id", authenticate, requireRole("admin"), adminDeleteReview);

// Support contact
router.post(
  "/support/contact",
  [
    body("name").trim().notEmpty().withMessage("Name is required"),
    body("email").isEmail().normalizeEmail().withMessage("Valid email is required"),
    body("subject").trim().notEmpty().withMessage("Subject is required"),
    body("message").trim().notEmpty().withMessage("Message is required"),
    body("category").trim().notEmpty().withMessage("Category is required"),
  ],
  validate,
  async (req: Request, res: Response): Promise<void> => {
    const { name, email, subject, message, category } = req.body as {
      name: string; email: string; subject: string; message: string; category: string;
    };

    try {
      // Email to support inbox
      await mailer.sendMail({
        from: `"Atelier Services Support" <${process.env.EMAIL_USER}>`,
        to: process.env.EMAIL_USER,
        replyTo: email,
        subject: `[Support] [${category}] ${subject}`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#fafafa;border-radius:12px">
            <h2 style="margin:0 0 4px;color:#111">New Support Query</h2>
            <p style="color:#888;font-size:13px;margin:0 0 24px">Received via Atelier Services support form</p>
            <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
              <tr><td style="padding:8px 0;color:#555;font-size:13px;width:100px">Name</td><td style="padding:8px 0;font-size:13px;font-weight:600">${name}</td></tr>
              <tr><td style="padding:8px 0;color:#555;font-size:13px">Email</td><td style="padding:8px 0;font-size:13px"><a href="mailto:${email}" style="color:#6366f1">${email}</a></td></tr>
              <tr><td style="padding:8px 0;color:#555;font-size:13px">Category</td><td style="padding:8px 0;font-size:13px">${category}</td></tr>
              <tr><td style="padding:8px 0;color:#555;font-size:13px">Subject</td><td style="padding:8px 0;font-size:13px;font-weight:600">${subject}</td></tr>
            </table>
            <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px">
              <p style="margin:0;font-size:14px;color:#111;line-height:1.7;white-space:pre-wrap">${message}</p>
            </div>
            <p style="color:#aaa;font-size:12px;margin-top:24px">Hit Reply to respond directly to ${email}</p>
          </div>
        `,
      });
      console.log(`[Support] Query from ${email} sent to inbox`);

      // Confirmation email to user
      await mailer.sendMail({
        from: `"Atelier Services" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: "We received your query — Atelier Services Support",
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#fafafa;border-radius:12px">
            <h2 style="margin:0 0 8px;color:#111">Hi ${name},</h2>
            <p style="color:#555;margin:0 0 16px">Thanks for reaching out. We've received your message and will get back to you within <strong>24–48 hours</strong>.</p>
            <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:16px">
              <p style="margin:0 0 4px;font-size:12px;color:#888;text-transform:uppercase;letter-spacing:1px">Your message</p>
              <p style="margin:0;font-size:14px;color:#111;line-height:1.7;white-space:pre-wrap">${message}</p>
            </div>
            <p style="color:#999;font-size:13px;margin:0">— The Atelier Services Team</p>
          </div>
        `,
      });
      console.log(`[Support] Confirmation sent to ${email}`);

      res.json({ success: true, message: "Your query has been sent. We'll get back to you within 24–48 hours." });
    } catch (err) {
      console.error("[Support] Failed to send email:", err);
      res.status(500).json({ success: false, message: "Failed to send your query. Please try again." });
    }
  },
);

// ============================================================
// SECTION 9 — APP SETUP & SERVER START
// ============================================================

const app: Express = express();

app.use(cors({
  origin: process.env.FRONTEND_URL ? [process.env.FRONTEND_URL, "http://localhost:8080"] : "*",
  credentials: true,
}));
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// Request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// API routes FIRST — before static files
app.use("/api", router);
app.use(errorHandler);

// Serve built frontend in production (only when public/ exists)
const publicDir = path.join(process.cwd(), "public");
app.use(express.static(publicDir));

// SPA fallback — serve index.html for all non-API routes
app.get("/{*path}", (req, res) => {
  if (req.path.startsWith("/api")) {
    res.status(404).json({ success: false, message: "API route not found" });
    return;
  }
  const indexPath = path.join(publicDir, "index.html");
  res.sendFile(indexPath, (err) => {
    if (err) res.status(404).json({ success: false, message: "Not found" });
  });
});

const PORT = Number(process.env.PORT ?? 3000);

async function initSchema() {
  try {
    await initDb();

    // Create enums (IF NOT EXISTS requires PG 14+)
    for (const def of [
      `CREATE TYPE role AS ENUM ('customer', 'vendor', 'admin')`,
      `CREATE TYPE booking_status AS ENUM ('pending', 'confirmed', 'completed', 'cancelled')`,
      `CREATE TYPE payment_status AS ENUM ('unpaid', 'paid')`,
    ]) {
      try { await pool.query(def); } catch { /* type already exists */ }
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL, role role NOT NULL DEFAULT 'customer',
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vendors (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        business_name TEXT NOT NULL, is_approved BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
      CREATE TABLE IF NOT EXISTS services (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
        price REAL NOT NULL, category TEXT NOT NULL,
        vendor_id TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
        rating REAL NOT NULL DEFAULT 0, review_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        phone TEXT, experience INTEGER DEFAULT 0, license_no TEXT,
        location TEXT, portfolio TEXT, background_check BOOLEAN DEFAULT false,
        images TEXT DEFAULT '[]', lat REAL, lng REAL,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bookings (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        vendor_id TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
        service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        date TEXT NOT NULL, time TEXT NOT NULL,
        status booking_status NOT NULL DEFAULT 'pending',
        payment_status payment_status NOT NULL DEFAULT 'unpaid',
        customer_name TEXT, customer_email TEXT, customer_phone TEXT,
        address TEXT, total_amount REAL, coupon_code TEXT,
        completion_photos TEXT DEFAULT '[]',
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        rating REAL NOT NULL, comment TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
      CREATE TABLE IF NOT EXISTS otp_store (
        email TEXT PRIMARY KEY,
        otp TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        name TEXT NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'customer',
        business_name TEXT,
        purpose TEXT NOT NULL DEFAULT 'signup',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    // Migrate existing otp_store tables that may lack the purpose column
    try { await pool.query(`ALTER TABLE otp_store ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'signup'`); } catch { /* column already exists */ }

    // Add booking_id and vendor_id columns to existing reviews table
    try { await pool.query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS booking_id TEXT REFERENCES bookings(id) ON DELETE CASCADE`); } catch { /* column already exists */ }
    try { await pool.query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS vendor_id TEXT REFERENCES vendors(id) ON DELETE CASCADE`); } catch { /* column already exists */ }
    try { await pool.query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS title TEXT DEFAULT ''`); } catch { /* column already exists */ }

    // Create promo_codes table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS promo_codes (
        id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL, description TEXT NOT NULL,
        discount_type TEXT NOT NULL DEFAULT 'percent',
        discount_value REAL NOT NULL,
        min_booking_amount REAL DEFAULT 0,
        max_discount REAL,
        valid_until TIMESTAMP NOT NULL,
        category TEXT DEFAULT 'all',
        first_time_only BOOLEAN DEFAULT false,
        one_time_per_user BOOLEAN DEFAULT false,
        is_active BOOLEAN DEFAULT true,
        usage_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
    `);
    try { await pool.query(`ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true`); } catch {}
    try { await pool.query(`ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS usage_count INTEGER DEFAULT 0`); } catch {}

    // Create promo_usage table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS promo_usage (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        promo_code_id TEXT NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
        used_at TIMESTAMP DEFAULT NOW() NOT NULL,
        booking_status TEXT NOT NULL DEFAULT 'pending',
        eligible_for_reuse BOOLEAN DEFAULT false,
        reuse_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
    `);

    // Create notifications table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'general',
        is_read BOOLEAN DEFAULT false,
        redirect_url TEXT,
        booking_id TEXT,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
    `);

    // Seed some default promo codes if table is empty
    const [promoCount] = await db.select({ count: count() }).from(promoCodesTable);
    if ((promoCount?.count ?? 0) === 0) {
      const promoData = [
        { code: 'WELCOME10', title: 'Welcome 10% Off', description: '10% off your first booking (max ₹500)', discountType: 'percent', discountValue: 10, maxDiscount: 500, validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), category: 'all', firstTimeOnly: true },
        { code: 'FLAT200', title: '₹200 Flat Off', description: '₹200 flat off on orders above ₹1000', discountType: 'flat', discountValue: 200, minBookingAmount: 1000, validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), category: 'all' },
        { code: 'WELLNESS15', title: 'Wellness 15% Off', description: '15% off on Health & Wellness services (max ₹800)', discountType: 'percent', discountValue: 15, maxDiscount: 800, validUntil: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000), category: 'Health & Wellness' },
        { code: 'STUDIO20', title: 'Studio 20% Off', description: '20% off on Home Studio services (max ₹1000)', discountType: 'percent', discountValue: 20, maxDiscount: 1000, validUntil: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000), category: 'Home Studio' },
        { code: 'WEEKEND50', title: 'Weekend Special ₹50', description: '₹50 flat off on any service', discountType: 'flat', discountValue: 50, validUntil: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), category: 'all' },
        { code: 'PREMIUM25', title: 'Premium 25% Off', description: '25% off on orders above ₹2000 (max ₹2000)', discountType: 'percent', discountValue: 25, minBookingAmount: 2000, maxDiscount: 2000, validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), category: 'all' },
      ];
      for (const p of promoData) {
        await db.insert(promoCodesTable).values({ id: generateId(), ...p }).onConflictDoNothing();
      }
      console.log(`[DB] Seeded ${promoData.length} default promo codes`);
    }

    // Seed admin user from env vars if configured
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;
    const adminName = process.env.ADMIN_NAME;
    if (adminEmail && adminPassword) {
      const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, adminEmail)).limit(1);
      if (!existing) {
        const hashed = await bcrypt.hash(adminPassword, 12);
        await db.insert(usersTable).values({
          id: generateId(),
          name: adminName || "Admin",
          email: adminEmail,
          password: hashed,
          role: "admin",
        });
        console.log(`[DB] Admin user created: ${adminEmail}`);
      } else if (existing.role !== "admin") {
        await db.update(usersTable).set({ role: "admin" }).where(eq(usersTable.email, adminEmail));
        console.log(`[DB] User ${adminEmail} promoted to admin`);
      } else {
        console.log(`[DB] Admin user already exists: ${adminEmail}`);
      }
    }

    console.log("[DB] Schema initialized");
  } catch (err) {
    console.error("[DB] Schema init error:", err);
  }
}

app.listen(PORT, async () => {
  await initSchema();
  console.log(`\n🚀 Multi-Vendor Service Booking Platform`);
  console.log(`   Server running on port ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/api/healthz\n`);
});

// NOTE: No export to avoid ESM/CJS cycle issues
