import { Request, Response } from "express";
import { db } from "@workspace/db";
import { bookingsTable, servicesTable, vendorsTable } from "@workspace/db/schema";
import { eq, and, count } from "drizzle-orm";
import { generateId } from "../utils/id.js";
import { getPagination, buildPagination } from "../utils/pagination.js";
import { type AuthRequest } from "../middlewares/auth.js";

export async function createBooking(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { serviceId, date, time } = req.body as {
    serviceId: string;
    date: string;
    time: string;
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

  const id = generateId();
  const [booking] = await db
    .insert(bookingsTable)
    .values({
      id,
      userId,
      vendorId: service.vendorId,
      serviceId,
      date,
      time,
    })
    .returning();

  res.status(201).json(booking);
}

export async function getMyBookings(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { status } = req.query as { status?: string };
  const { page, limit, offset } = getPagination(req.query);

  const conditions: any[] = [eq(bookingsTable.userId, userId)];
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
