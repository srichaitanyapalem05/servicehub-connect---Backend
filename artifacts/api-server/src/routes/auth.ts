import { Router } from "express";
import { body } from "express-validator";
import { registerCustomer, login, getUserProfile } from "../controllers/auth.controller.js";
import { authenticate } from "../middlewares/auth.js";
import { validate } from "../middlewares/validate.js";

const router = Router();

router.post(
  "/auth/register",
  [
    body("name").trim().notEmpty().withMessage("Name is required"),
    body("email").isEmail().normalizeEmail().withMessage("Valid email is required"),
    body("password").isLength({ min: 6 }).withMessage("Password must be at least 6 characters"),
  ],
  validate,
  registerCustomer,
);

router.post(
  "/auth/login",
  [
    body("email").isEmail().normalizeEmail().withMessage("Valid email is required"),
    body("password").notEmpty().withMessage("Password is required"),
  ],
  validate,
  login,
);

router.get("/users/profile", authenticate, getUserProfile);

export default router;
