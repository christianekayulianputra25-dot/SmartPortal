import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.disable("x-powered-by");

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

const allowedOriginsRaw = process.env["CORS_ALLOWED_ORIGINS"]?.trim();
const allowedOrigins = allowedOriginsRaw
  ? allowedOriginsRaw
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean)
  : null;

app.use(
  cors({
    origin: (origin, cb) => {
      // Same-origin / non-browser callers (no Origin header) are always allowed.
      if (!origin) return cb(null, true);
      if (!allowedOrigins) {
        // Dev default: allow any origin. In production set CORS_ALLOWED_ORIGINS.
        if (process.env["NODE_ENV"] === "production") {
          return cb(null, false);
        }
        return cb(null, true);
      }
      return cb(null, allowedOrigins.includes(origin));
    },
  }),
);

app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true, limit: "256kb" }));

app.use("/api", router);

// 404 for unknown /api/* routes (HTML defaults leak framework info).
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not Found" });
});

// Centralized error handler. Hides internals in production, logs everything.
app.use(
  (
    err: Error & { status?: number; statusCode?: number },
    req: Request,
    res: Response,
    _next: NextFunction,
  ) => {
    const status = err.status ?? err.statusCode ?? 500;
    (req as Request & { log?: { error: (...args: unknown[]) => void } }).log?.error?.(
      { err },
      "request failed",
    );
    if (res.headersSent) return;
    res.status(status).json({
      error:
        status >= 500 && process.env["NODE_ENV"] === "production"
          ? "Internal Server Error"
          : err.message || "Internal Server Error",
    });
  },
);

export default app;
