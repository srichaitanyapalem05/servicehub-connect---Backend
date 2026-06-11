import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { usersTable, vendorsTable, servicesTable, bookingsTable } from "@workspace/db/schema";
import { eq, and, count, sum } from "drizzle-orm";
import { generateId } from "../utils/id.js";
import { generateToken, type AuthRequest } from "../middlewares/auth.js";
import { getPagination, buildPagination } from "../utils/pagination.js";

export async function registerVendor(req: Request, res: Response): Promise<void> {
  const { name, email, password, businessName } = req.body as {
    name: string;
    email: string;
    password: string;
    businessName: string;
  };

  const existing = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (existing.length > 0) {
    res.status(400).json({ success: false, message: "Email already registered" });
    return;
  }

  const hashed = await bcrypt.hash(password, 12);
  const userId = generateId();
  const vendorId = generateId();

  const [user] = await db
    .insert(usersTable)
    .values({ id: userId, name, email, password: hashed, role: "vendor" })
    .returning();

  const [vendor] = await db
    .insert(vendorsTable)
    .values({ id: vendorId, userId: user.id, businessName, isApproved: false })
    .returning();

  const token = generateToken({ id: user.id, role: user.role, email: user.email });

  res.status(201).json({
    success: true,
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
    },
    vendor: {
      id: vendor.id,
      businessName: vendor.businessName,
      isApproved: vendor.isApproved,
    },
  });
}

export async function vendorLogin(req: Request, res: Response): Promise<void> {
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
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
    },
  });
}

export async function getVendorDashboard(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;

  const [vendor] = await db
    .select()
    .from(vendorsTable)
    .where(eq(vendorsTable.userId, userId))
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
    .select({ status: bookingsTable.status, paymentStatus: bookingsTable.paymentStatus })
    .from(bookingsTable)
    .where(eq(bookingsTable.vendorId, vendor.id));

  const totalBookings = allBookings.length;
  const pendingBookings = allBookings.filter((b) => b.status === "pending").length;
  const confirmedBookings = allBookings.filter((b) => b.status === "confirmed").length;
  const completedBookings = allBookings.filter((b) => b.status === "completed").length;

  const completedPaidBookingIds = allBookings
    .filter((b) => b.status === "completed" && b.paymentStatus === "paid")
    .length;

  const paidBookings = await db
    .select({ serviceId: bookingsTable.serviceId })
    .from(bookingsTable)
    .where(and(eq(bookingsTable.vendorId, vendor.id), eq(bookingsTable.paymentStatus, "paid")));

  let totalEarnings = 0;
  for (const booking of paidBookings) {
    const [svc] = await db
      .select({ price: servicesTable.price })
      .from(servicesTable)
      .where(eq(servicesTable.id, booking.serviceId))
      .limit(1);
    if (svc) totalEarnings += svc.price;
  }

  res.json({
    success: true,
    data: {
      totalServices: serviceCount?.count ?? 0,
      totalBookings,
      pendingBookings,
      confirmedBookings,
      completedBookings,
      totalEarnings,
    },
  });
}

export async function getVendorBookings(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { status } = req.query as { status?: string };
  const { page, limit, offset } = getPagination(req.query);

  const [vendor] = await db
    .select()
    .from(vendorsTable)
    .where(eq(vendorsTable.userId, userId))
    .limit(1);

  if (!vendor) {
    res.status(404).json({ success: false, message: "Vendor profile not found" });
    return;
  }

  const conditions = [eq(bookingsTable.vendorId, vendor.id)];
  if (status) {
    conditions.push(eq(bookingsTable.status, status as any));
  }

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

export async function updateVendorBooking(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { id } = req.params;
  const { status } = req.body as { status: "confirmed" | "completed" | "cancelled" };

  const [vendor] = await db
    .select()
    .from(vendorsTable)
    .where(eq(vendorsTable.userId, userId))
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

export async function uploadCompletionPhotos(req: AuthRequest, res: Response): Promise<void> {
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

  const [vendor] = await db
    .select()
    .from(vendorsTable)
    .where(eq(vendorsTable.userId, req.user!.id))
    .limit(1);
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
}
