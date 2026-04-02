import { Request, Response } from "express";
import { db } from "@workspace/db";
import { servicesTable, vendorsTable } from "@workspace/db/schema";
import { eq, and, gte, lte, ilike, asc, desc, count } from "drizzle-orm";
import { generateId } from "../utils/id.js";
import { getPagination, buildPagination } from "../utils/pagination.js";
import { type AuthRequest } from "../middlewares/auth.js";

export async function getServices(req: Request, res: Response): Promise<void> {
  const {
    category,
    minPrice,
    maxPrice,
    minRating,
    search,
    sortBy = "createdAt",
    sortOrder = "desc",
  } = req.query as {
    category?: string;
    minPrice?: string;
    maxPrice?: string;
    minRating?: string;
    search?: string;
    sortBy?: string;
    sortOrder?: string;
  };

  const { page, limit, offset } = getPagination(req.query);

  const conditions: any[] = [];
  if (category) conditions.push(eq(servicesTable.category, category));
  if (minPrice) conditions.push(gte(servicesTable.price, Number(minPrice)));
  if (maxPrice) conditions.push(lte(servicesTable.price, Number(maxPrice)));
  if (minRating) conditions.push(gte(servicesTable.rating, Number(minRating)));
  if (search) conditions.push(ilike(servicesTable.title, `%${search}%`));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const sortColumn =
    sortBy === "price"
      ? servicesTable.price
      : sortBy === "rating"
        ? servicesTable.rating
        : servicesTable.createdAt;

  const orderFn = sortOrder === "asc" ? asc : desc;

  const [totalResult] = await db
    .select({ count: count() })
    .from(servicesTable)
    .where(whereClause);

  const services = await db
    .select()
    .from(servicesTable)
    .where(whereClause)
    .orderBy(orderFn(sortColumn))
    .limit(limit)
    .offset(offset);

  res.json({
    success: true,
    data: services,
    pagination: buildPagination(page, limit, totalResult?.count ?? 0),
  });
}

export async function getServiceById(req: Request, res: Response): Promise<void> {
  const { id } = req.params;

  const [service] = await db
    .select()
    .from(servicesTable)
    .where(eq(servicesTable.id, id))
    .limit(1);

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

export async function createService(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { title, description, price, category } = req.body as {
    title: string;
    description: string;
    price: number;
    category: string;
  };

  const [vendor] = await db
    .select()
    .from(vendorsTable)
    .where(eq(vendorsTable.userId, userId))
    .limit(1);

  if (!vendor) {
    res.status(403).json({ success: false, message: "No vendor profile found" });
    return;
  }

  if (!vendor.isApproved) {
    res.status(403).json({ success: false, message: "Vendor account not yet approved" });
    return;
  }

  const id = generateId();
  const [service] = await db
    .insert(servicesTable)
    .values({ id, title, description, price, category, vendorId: vendor.id })
    .returning();

  res.status(201).json(service);
}

export async function updateService(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { id } = req.params;
  const { title, description, price, category } = req.body as {
    title?: string;
    description?: string;
    price?: number;
    category?: string;
  };

  const [vendor] = await db
    .select()
    .from(vendorsTable)
    .where(eq(vendorsTable.userId, userId))
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

  const updates: Partial<typeof service> = {};
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

export async function deleteService(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { id } = req.params;

  const [vendor] = await db
    .select()
    .from(vendorsTable)
    .where(eq(vendorsTable.userId, userId))
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
