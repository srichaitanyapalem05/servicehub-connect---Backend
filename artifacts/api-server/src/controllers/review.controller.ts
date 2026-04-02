import { Request, Response } from "express";
import { db } from "@workspace/db";
import { reviewsTable, servicesTable, usersTable } from "@workspace/db/schema";
import { eq, count, avg } from "drizzle-orm";
import { generateId } from "../utils/id.js";
import { getPagination, buildPagination } from "../utils/pagination.js";
import { type AuthRequest } from "../middlewares/auth.js";

export async function createReview(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { serviceId, rating, comment } = req.body as {
    serviceId: string;
    rating: number;
    comment: string;
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
  const [review] = await db
    .insert(reviewsTable)
    .values({ id, userId, serviceId, rating, comment })
    .returning();

  const [stats] = await db
    .select({ avg: avg(reviewsTable.rating), count: count() })
    .from(reviewsTable)
    .where(eq(reviewsTable.serviceId, serviceId));

  await db
    .update(servicesTable)
    .set({
      rating: Number(Number(stats?.avg ?? 0).toFixed(2)),
      reviewCount: stats?.count ?? 0,
    })
    .where(eq(servicesTable.id, serviceId));

  const [user] = await db
    .select({ name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  res.status(201).json({ ...review, user: { name: user?.name ?? "Anonymous" } });
}

export async function getServiceReviews(req: Request, res: Response): Promise<void> {
  const { serviceId } = req.params;
  const { page, limit, offset } = getPagination(req.query);

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
      id: r.id,
      userId: r.userId,
      serviceId: r.serviceId,
      rating: r.rating,
      comment: r.comment,
      createdAt: r.createdAt,
      user: { name: r.userName ?? "Anonymous" },
    })),
    pagination: buildPagination(page, limit, totalResult?.count ?? 0),
  });
}
