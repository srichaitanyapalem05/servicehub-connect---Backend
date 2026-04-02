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
import pg from "pg";

const { Pool } = pg;

// ============================================================
// SECTION 1 — DATABASE CONNECTION
// ============================================================

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

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
  rating: real("rating").notNull(),
  comment: text("comment").notNull(),
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
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ success: false, message: "No token provided" });
    return;
  }
  const token = authHeader.split(" ")[1];
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

  const hashed = await bcrypt.hash(password, 12);
  const id = generateId();
  const [user] = await db
    .insert(usersTable)
    .values({ id, name, email, password: hashed, role: "customer" })
    .returning();

  const token = generateToken({ id: user.id, role: user.role, email: user.email });
  res.status(201).json({
    success: true,
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt },
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

  const hashed = await bcrypt.hash(password, 12);
  const [user] = await db
    .insert(usersTable)
    .values({ id: generateId(), name, email, password: hashed, role: "vendor" })
    .returning();

  const [vendor] = await db
    .insert(vendorsTable)
    .values({ id: generateId(), userId: user.id, businessName, isApproved: false })
    .returning();

  const token = generateToken({ id: user.id, role: user.role, email: user.email });
  res.status(201).json({
    success: true,
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt },
    vendor: { id: vendor.id, businessName: vendor.businessName, isApproved: vendor.isApproved },
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

  const conditions: any[] = [eq(bookingsTable.vendorId, vendor.id)];
  if (status) conditions.push(eq(bookingsTable.status, status as any));

  const [totalResult] = await db
    .select({ count: count() })
    .from(bookingsTable)
    .where(and(...conditions));

  const bookings = await db
    .select()
    .from(bookingsTable)
    .where(and(...conditions))
    .limit(limit)
    .offset(offset);

  res.json({
    success: true,
    data: bookings,
    pagination: buildPagination(page, limit, totalResult?.count ?? 0),
  });
}

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

  res.json(updated);
}

// ── Services ──────────────────────────────────────────────────

async function getServices(req: Request, res: Response): Promise<void> {
  const {
    category, minPrice, maxPrice, minRating, search,
    sortBy = "createdAt", sortOrder = "desc",
  } = req.query as Record<string, string | undefined>;

  const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);

  const conditions: any[] = [];
  if (category) conditions.push(eq(servicesTable.category, category));
  if (minPrice) conditions.push(gte(servicesTable.price, Number(minPrice)));
  if (maxPrice) conditions.push(lte(servicesTable.price, Number(maxPrice)));
  if (minRating) conditions.push(gte(servicesTable.rating, Number(minRating)));
  if (search) conditions.push(ilike(servicesTable.title, `%${search}%`));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const sortColumn =
    sortBy === "price" ? servicesTable.price
    : sortBy === "rating" ? servicesTable.rating
    : servicesTable.createdAt;
  const orderFn = sortOrder === "asc" ? asc : desc;

  const [totalResult] = await db.select({ count: count() }).from(servicesTable).where(whereClause);
  const services = await db
    .select()
    .from(servicesTable)
    .where(whereClause)
    .orderBy(orderFn(sortColumn))
    .limit(limit)
    .offset(offset);

  res.json({ success: true, data: services, pagination: buildPagination(page, limit, totalResult?.count ?? 0) });
}

async function getServiceById(req: Request, res: Response): Promise<void> {
  const { id } = req.params;

  const [service] = await db.select().from(servicesTable).where(eq(servicesTable.id, id)).limit(1);
  if (!service) {
    res.status(404).json({ success: false, message: "Service not found" });
    return;
  }

  const [vendor] = await db
    .select({ id: vendorsTable.id, businessName: vendorsTable.businessName })
    .from(vendorsTable)
    .where(eq(vendorsTable.id, service.vendorId))
    .limit(1);

  res.json({ ...service, vendor: vendor ?? null });
}

async function createService(req: AuthRequest, res: Response): Promise<void> {
  const { title, description, price, category } = req.body as {
    title: string; description: string; price: number; category: string;
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
  if (!vendor.isApproved) {
    res.status(403).json({ success: false, message: "Vendor account not yet approved" });
    return;
  }

  const [service] = await db
    .insert(servicesTable)
    .values({ id: generateId(), title, description, price, category, vendorId: vendor.id })
    .returning();

  res.status(201).json(service);
}

async function updateService(req: AuthRequest, res: Response): Promise<void> {
  const { id } = req.params;
  const { title, description, price, category } = req.body as Record<string, unknown>;

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
  const { serviceId, date, time } = req.body as { serviceId: string; date: string; time: string };

  const [service] = await db
    .select()
    .from(servicesTable)
    .where(eq(servicesTable.id, serviceId))
    .limit(1);

  if (!service) {
    res.status(404).json({ success: false, message: "Service not found" });
    return;
  }

  const [booking] = await db
    .insert(bookingsTable)
    .values({ id: generateId(), userId: req.user!.id, vendorId: service.vendorId, serviceId, date, time })
    .returning();

  res.status(201).json(booking);
}

async function getMyBookings(req: AuthRequest, res: Response): Promise<void> {
  const { status } = req.query as { status?: string };
  const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);

  const conditions: any[] = [eq(bookingsTable.userId, req.user!.id)];
  if (status) conditions.push(eq(bookingsTable.status, status as any));

  const [totalResult] = await db
    .select({ count: count() })
    .from(bookingsTable)
    .where(and(...conditions));

  const bookings = await db
    .select()
    .from(bookingsTable)
    .where(and(...conditions))
    .limit(limit)
    .offset(offset);

  res.json({ success: true, data: bookings, pagination: buildPagination(page, limit, totalResult?.count ?? 0) });
}

// ── Reviews ───────────────────────────────────────────────────

async function createReview(req: AuthRequest, res: Response): Promise<void> {
  const { serviceId, rating, comment } = req.body as {
    serviceId: string; rating: number; comment: string;
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

  const [review] = await db
    .insert(reviewsTable)
    .values({ id: generateId(), userId: req.user!.id, serviceId, rating, comment })
    .returning();

  const [stats] = await db
    .select({ avg: avg(reviewsTable.rating), count: count() })
    .from(reviewsTable)
    .where(eq(reviewsTable.serviceId, serviceId));

  await db
    .update(servicesTable)
    .set({ rating: Number(Number(stats?.avg ?? 0).toFixed(2)), reviewCount: stats?.count ?? 0 })
    .where(eq(servicesTable.id, serviceId));

  const [user] = await db
    .select({ name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.id, req.user!.id))
    .limit(1);

  res.status(201).json({ ...review, user: { name: user?.name ?? "Anonymous" } });
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
  const vendors = await db.select().from(vendorsTable).where(whereClause).limit(limit).offset(offset);

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
  const bookings = await db.select().from(bookingsTable).where(whereClause).limit(limit).offset(offset);

  res.json({ success: true, data: bookings, pagination: buildPagination(page, limit, totalResult?.count ?? 0) });
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

  const paidBookings = await db
    .select({ serviceId: bookingsTable.serviceId })
    .from(bookingsTable)
    .where(eq(bookingsTable.paymentStatus, "paid"));

  let totalRevenue = 0;
  for (const { serviceId } of paidBookings) {
    const [svc] = await db.select({ price: servicesTable.price }).from(servicesTable).where(eq(servicesTable.id, serviceId)).limit(1);
    if (svc) totalRevenue += svc.price;
  }

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
    },
  });
}

// ============================================================
// SECTION 8 — ROUTES
// ============================================================

const router = Router();

// Health
router.get("/healthz", (_req, res) => res.json({ status: "ok" }));

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

// Reviews
router.post(
  "/reviews",
  authenticate,
  [
    body("serviceId").notEmpty().withMessage("Service ID is required"),
    body("rating").isFloat({ min: 1, max: 5 }).withMessage("Rating must be between 1 and 5"),
    body("comment").trim().notEmpty().withMessage("Comment is required"),
  ],
  validate,
  createReview,
);

router.get("/reviews/service/:serviceId", getServiceReviews);

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

// ============================================================
// SECTION 9 — APP SETUP & SERVER START
// ============================================================

const app: Express = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.use("/api", router);
app.use(errorHandler);

const PORT = Number(process.env.PORT ?? 3000);

app.listen(PORT, () => {
  console.log(`\n🚀 Multi-Vendor Service Booking Platform`);
  console.log(`   Server running on port ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/api/healthz\n`);
});

export default app;
