import { Router, type IRouter } from "express";
import healthRouter from "./health";
import kvRouter from "./kv";

const router: IRouter = Router();

router.use(healthRouter);
router.use(kvRouter);

export default router;
