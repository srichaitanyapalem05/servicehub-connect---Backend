import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "./auth.js";
import vendorRouter from "./vendor.js";
import servicesRouter from "./services.js";
import bookingsRouter from "./bookings.js";
import reviewsRouter from "./reviews.js";
import paymentsRouter from "./payments.js";
import adminRouter from "./admin.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(vendorRouter);
router.use(servicesRouter);
router.use(bookingsRouter);
router.use(reviewsRouter);
router.use(paymentsRouter);
router.use(adminRouter);

export default router;
