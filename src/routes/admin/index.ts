import { Router } from "express";
import { requireAuth } from "../../auth/requireAuth";
import { businessRouter } from "./business";
import { catalogRouter } from "./catalog";
import { paymentsRouter } from "./payments";
import { faqRouter } from "./faq";
import { teamRouter } from "./team";
import { insightsRouter } from "./insights";
import { customersRouter } from "./customers";
import { ordersRouter } from "./orders";
import { conversationsRouter } from "./conversations";

export const adminRouter = Router();

adminRouter.use("/api", requireAuth);

adminRouter.use(businessRouter);
adminRouter.use(catalogRouter);
adminRouter.use(paymentsRouter);
adminRouter.use(faqRouter);
adminRouter.use(teamRouter);
adminRouter.use(insightsRouter);
adminRouter.use(customersRouter);
adminRouter.use(ordersRouter);
adminRouter.use(conversationsRouter);
