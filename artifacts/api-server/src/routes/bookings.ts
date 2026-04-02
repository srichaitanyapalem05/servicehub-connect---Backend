import { Router } from "express";
import { body } from "express-validator";
import { createBooking, getMyBookings } from "../controllers/booking.controller.js";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { validate } from "../middlewares/validate.js";

const router = Router();

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

router.get("/bookings/my", authenticate, getMyBookings);

export default router;
