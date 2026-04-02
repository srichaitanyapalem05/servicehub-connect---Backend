import { Response } from "express";
import { db } from "@workspace/db";
import { bookingsTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { generateId } from "../utils/id.js";
import { type AuthRequest } from "../middlewares/auth.js";

export async function processPayment(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { bookingId, amount } = req.body as { bookingId: string; amount: number };

  const [booking] = await db
    .select()
    .from(bookingsTable)
    .where(and(eq(bookingsTable.id, bookingId), eq(bookingsTable.userId, userId)))
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

  const transactionId = generateId();

  res.json({
    success: true,
    message: "Payment processed successfully",
    transactionId,
    bookingId,
    amount,
    paymentStatus: "paid",
  });
}
