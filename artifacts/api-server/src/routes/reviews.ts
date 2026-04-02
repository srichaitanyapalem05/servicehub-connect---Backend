import { Router } from "express";
import { body } from "express-validator";
import { createReview, getServiceReviews } from "../controllers/review.controller.js";
import { authenticate } from "../middlewares/auth.js";
import { validate } from "../middlewares/validate.js";

const router = Router();

router.post(
  "/reviews",
  authenticate,
  [
    body("serviceId").notEmpty().withMessage("Service ID is required"),
    body("rating").isFloat({ min: 1, max: 5 }).withMessage("Rating must be between 1 and 5"),
    body("comment").trim().notEmpty().withMessage("Comment is required"),
  ],
  validate,
  createReview,
);

router.get("/reviews/service/:serviceId", getServiceReviews);

export default router;
