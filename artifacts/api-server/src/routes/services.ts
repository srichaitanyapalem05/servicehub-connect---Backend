import { Router } from "express";
import { body } from "express-validator";
import {
  getServices,
  getServiceById,
  createService,
  updateService,
  deleteService,
} from "../controllers/service.controller.js";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { validate } from "../middlewares/validate.js";

const router = Router();

router.get("/services", getServices);

router.get("/services/:id", getServiceById);

router.post(
  "/services",
  authenticate,
  requireRole("vendor"),
  [
    body("title").trim().notEmpty().withMessage("Title is required"),
    body("description").trim().notEmpty().withMessage("Description is required"),
    body("price").isFloat({ min: 0 }).withMessage("Price must be a positive number"),
    body("category").trim().notEmpty().withMessage("Category is required"),
  ],
  validate,
  createService,
);

router.put(
  "/services/:id",
  authenticate,
  requireRole("vendor"),
  [
    body("price").optional().isFloat({ min: 0 }).withMessage("Price must be a positive number"),
  ],
  validate,
  updateService,
);

router.delete("/services/:id", authenticate, requireRole("vendor"), deleteService);

export default router;
