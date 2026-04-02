import { Request, Response } from "express";
import { db } from "@workspace/db";
import { usersTable, vendorsTable, servicesTable, bookingsTable } from "@workspace/db/schema";
import { eq, count, sum, and } from "drizzle-orm";
import { getPagination, buildPagination } from "../utils/pagination.js";

export async function adminGetUsers(req: Request, res: Response): Promise<void> {
  const { role } = req.query as { role?: string };
  const { page, limit, offset } = getPagination(req.query);

  const conditions: any[] = [];
  if (role) {
    conditions.push(eq(usersTable.role, role as any));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [totalResult] = await db
    .select({ count: count() })
    .from(usersTable)
    .where(whereClause);

  const users = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      role: usersTable.role,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .where(whereClause)
    .limit(limit)
    .offset(offset);

  res.json({
    success: true,
    data: users,
    pagination: buildPagination(page, limit, totalResult?.count ?? 0),
  });
}

export async function adminDeleteUser(req: Request, res: Response): Promise<void> {
  const { id } = req.params;

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
  if (!user) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }

  await db.delete(usersTable).where(eq(usersTable.id, id));
  res.json({ success: true, message: "User deleted" });
}

export async function adminGetVendors(req: Request, res: Response): Promise<void> {
  const { approved } = req.query as { approved?: string };
  const { page, limit, offset } = getPagination(req.query);

  const conditions: any[] = [];
  if (approved !== undefined) {
    conditions.push(eq(vendorsTable.isApproved, approved === "true"));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [totalResult] = await db
    .select({ count: count() })
    .from(vendorsTable)
    .where(whereClause);

  const vendors = await db
    .select()
    .from(vendorsTable)
    .where(whereClause)
    .limit(limit)
    .offset(offset);

  res.json({
    success: true,
    data: vendors,
    pagination: buildPagination(page, limit, totalResult?.count ?? 0),
  });
}

export async function adminApproveVendor(req: Request, res: Response): Promise<void> {
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

export async function adminGetBookings(req: Request, res: Response): Promise<void> {
  const { status } = req.query as { status?: string };
  const { page, limit, offset } = getPagination(req.query);

  const conditions: any[] = [];
  if (status) {
    conditions.push(eq(bookingsTable.status, status as any));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [totalResult] = await db
    .select({ count: count() })
    .from(bookingsTable)
    .where(whereClause);

  const bookings = await db
    .select()
    .from(bookingsTable)
    .where(whereClause)
    .limit(limit)
    .offset(offset);

  res.json({
    success: true,
    data: bookings,
    pagination: buildPagination(page, limit, totalResult?.count ?? 0),
  });
}

export async function adminGetReports(req: Request, res: Response): Promise<void> {
  const [totalUsers] = await db.select({ count: count() }).from(usersTable);
  const [totalVendors] = await db.select({ count: count() }).from(vendorsTable);
  const [approvedVendors] = await db
    .select({ count: count() })
    .from(vendorsTable)
    .where(eq(vendorsTable.isApproved, true));
  const [pendingVendors] = await db
    .select({ count: count() })
    .from(vendorsTable)
    .where(eq(vendorsTable.isApproved, false));
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

  const paidBookingServiceIds = await db
    .select({ serviceId: bookingsTable.serviceId })
    .from(bookingsTable)
    .where(eq(bookingsTable.paymentStatus, "paid"));

  let totalRevenue = 0;
  for (const { serviceId } of paidBookingServiceIds) {
    const [svc] = await db
      .select({ price: servicesTable.price })
      .from(servicesTable)
      .where(eq(servicesTable.id, serviceId))
      .limit(1);
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
