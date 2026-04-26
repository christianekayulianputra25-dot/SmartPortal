import { Router, type IRouter, type Response } from "express";
import { db, kvStoreTable } from "@workspace/db";
import { gt, inArray, sql } from "drizzle-orm";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// In-memory Server-Sent Events (SSE) subscriber registry.
// Every browser tab opens a long-lived EventSource on /api/kv/stream and gets
// instant push updates whenever any other client writes through PUT /api/kv.
// Polling on /api/kv?since=... remains as a resilience fallback.
// ---------------------------------------------------------------------------
type SseClient = {
  id: number;
  res: Response;
};
const sseClients: Set<SseClient> = new Set();
let sseClientSeq = 0;

function sseSend(client: SseClient, event: string, data: unknown) {
  try {
    client.res.write(`event: ${event}\n`);
    client.res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    // ignore - client will be reaped on close
  }
}

function broadcast(event: string, data: unknown) {
  for (const client of sseClients) {
    sseSend(client, event, data);
  }
}

// Heartbeat keeps proxies (Vite, nginx, Replit edge) from closing the stream.
setInterval(() => {
  for (const client of sseClients) {
    try {
      client.res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      // ignore
    }
  }
}, 15000).unref?.();

router.get("/kv/stream", (req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable proxy buffering
  res.flushHeaders?.();

  const client: SseClient = { id: ++sseClientSeq, res };
  sseClients.add(client);

  // Initial hello so the client knows the stream is live.
  sseSend(client, "hello", {
    serverTime: new Date().toISOString(),
    clientId: client.id,
  });

  const cleanup = () => {
    sseClients.delete(client);
    try {
      res.end();
    } catch {
      // ignore
    }
  };
  req.on("close", cleanup);
  req.on("aborted", cleanup);
  res.on("error", cleanup);
});

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
    const originId =
      typeof body.originId === "string" ? body.originId : undefined;

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

    const serverTime = new Date().toISOString();

    // Push to every other connected device immediately.
    if (writes.length > 0 || deletes.length > 0) {
      broadcast("kv", {
        serverTime,
        originId,
        entries: [
          ...writes.map((w) => ({
            key: w.key,
            value: w.value,
            updatedAt: serverTime,
          })),
          ...deletes.map((k) => ({
            key: k,
            value: null,
            updatedAt: serverTime,
          })),
        ],
      });
    }

    res.json({
      serverTime,
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
    broadcast("kv", {
      serverTime: new Date().toISOString(),
      cleared: true,
      entries: [],
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
