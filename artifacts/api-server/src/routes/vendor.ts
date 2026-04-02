import { Router } from "express";
import { body } from "express-validator";
import {
  registerVendor,
  vendorLogin,
  getVendorDashboard,
  getVendorBookings,
  updateVendorBooking,
} from "../controllers/vendor.controller.js";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { validate } from "../middlewares/validate.js";

const router = Router();

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

export default router;
