import { Router } from "express";
import { body } from "express-validator";
import {
  adminGetUsers,
  adminDeleteUser,
  adminGetVendors,
  adminApproveVendor,
  adminGetBookings,
  adminGetReports,
} from "../controllers/admin.controller.js";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { validate } from "../middlewares/validate.js";

const router = Router();

router.use(authenticate, requireRole("admin"));

router.get("/admin/users", adminGetUsers);
router.delete("/admin/users/:id", adminDeleteUser);
router.get("/admin/vendors", adminGetVendors);
router.patch(
  "/admin/vendors/:id/approve",
  [body("isApproved").isBoolean().withMessage("isApproved must be a boolean")],
  validate,
  adminApproveVendor,
);
router.get("/admin/bookings", adminGetBookings);
router.get("/admin/reports", adminGetReports);

export default router;
