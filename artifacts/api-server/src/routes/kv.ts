import { Router, type IRouter } from "express";
import { db, kvStoreTable } from "@workspace/db";
import { gt, inArray, sql } from "drizzle-orm";

const router: IRouter = Router();

router.get("/kv", async (req, res, next) => {
  try {
    const sinceRaw = typeof req.query.since === "string" ? req.query.since : "";
    const since = sinceRaw ? new Date(sinceRaw) : null;

    let rows;
    if (since && !Number.isNaN(since.getTime())) {
      rows = await db
        .select()
        .from(kvStoreTable)
        .where(gt(kvStoreTable.updatedAt, since));
    } else {
      rows = await db.select().from(kvStoreTable);
    }

    res.json({
      serverTime: new Date().toISOString(),
      entries: rows.map((r) => ({
        key: r.key,
        value: r.value,
        updatedAt: r.updatedAt.toISOString(),
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.put("/kv", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const writesRaw = Array.isArray(body.writes) ? body.writes : [];
    const deletesRaw = Array.isArray(body.deletes) ? body.deletes : [];

    const writes = writesRaw
      .filter(
        (w: unknown): w is { key: string; value: string | null } =>
          !!w &&
          typeof (w as { key?: unknown }).key === "string" &&
          (w as { key: string }).key.length > 0 &&
          (w as { key: string }).key.length <= 256,
      )
      .map((w) => ({
        key: w.key,
        value: w.value == null ? null : String(w.value),
      }));

    const deletes = deletesRaw.filter(
      (k: unknown): k is string =>
        typeof k === "string" && k.length > 0 && k.length <= 256,
    );

    if (writes.length > 0) {
      await db
        .insert(kvStoreTable)
        .values(
          writes.map((w) => ({
            key: w.key,
            value: w.value,
          })),
        )
        .onConflictDoUpdate({
          target: kvStoreTable.key,
          set: {
            value: sql`excluded.value`,
            updatedAt: sql`now()`,
          },
        });
    }

    if (deletes.length > 0) {
      await db.delete(kvStoreTable).where(inArray(kvStoreTable.key, deletes));
    }

    res.json({
      serverTime: new Date().toISOString(),
      written: writes.length,
      deleted: deletes.length,
    });
  } catch (err) {
    next(err);
  }
});

router.delete("/kv", async (_req, res, next) => {
  try {
    await db.delete(kvStoreTable);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
