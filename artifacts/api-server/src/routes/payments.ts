import { Router } from "express";
import { body } from "express-validator";
import { processPayment } from "../controllers/payment.controller.js";
import { authenticate } from "../middlewares/auth.js";
import { validate } from "../middlewares/validate.js";

const router = Router();

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

export default router;
