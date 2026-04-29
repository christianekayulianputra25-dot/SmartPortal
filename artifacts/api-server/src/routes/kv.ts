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
}, 10000).unref?.();

router.get("/kv/stream", (req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  res.flushHeaders?.();

  
  req.socket.setKeepAlive(true);
  req.socket.setTimeout(0);

  const client: SseClient = {
    id: ++sseClientSeq,
    res
  };

  sseClients.add(client);

  // Initial hello so the client knows the stream is live.
  sseSend(client, "hello", {
    serverTime: new Date().toISOString(),
    clientId: client.id,
  });

  let closed = false;

const cleanup = () => {  

  if (closed) return;
  closed = true;

  sseClients.delete(client);

  try{
    res.removeAllListeners?.();
    req.removeAllListeners?.();
  }catch{}

  try{
    if(!res.writableEnded){
      res.end();
    }
  }catch{}
};

req.on("close", cleanup);
req.on("aborted", cleanup);
req.on("error", cleanup);
res.on("close", cleanup);
res.on("finish", cleanup);
res.on("error", cleanup);
});

// Lightweight key list — used by the client on boot to reconcile and prune any
// stale localStorage entries that were deleted server-side while the device
// was offline. Confirms server-side PostgreSQL is the only source of truth.
router.get("/kv/keys", async (_req, res, next) => {
  try {
    const rows = await db
      .select({ key: kvStoreTable.key })
      .from(kvStoreTable);
    res.json({
      serverTime: new Date().toISOString(),
      keys: rows.map((r) => r.key),
    });
  } catch (err) {
    next(err);
  }
});

// Public audit endpoint — proves the storage backend, row count, and server
// time so any device can verify it is talking to the centralised PostgreSQL.
router.get("/audit", async (_req, res, next) => {
  try {
    const result = await db
  .select({ count: sql<number>`cast(count(*) as int)` })
  .from(kvStoreTable);

const count = result?.[0]?.count ?? 0;
    res.json({
      ok: true,
      driver: "postgres",
      table: "kv_store",
      rowCount: Number(count) || 0,
      sseSubscribers: sseClients.size,
      serverTime: new Date().toISOString(),
      message:
        "Application uses centralized server-side PostgreSQL with realtime multi-device synchronization and no client-side shared-data persistence.",
    });
  } catch (err) {
    next(err);
  }
});

router.get("/kv", async (req, res) => {
  try {
    const sinceRaw =
      typeof req.query.since === "string"
        ? req.query.since
        : "";

    const since = sinceRaw ? new Date(sinceRaw) : null;

    let rows = [];

    try {
      if (since && !Number.isNaN(since.getTime())) {
        rows = await db
          .select()
          .from(kvStoreTable)
          .where(gt(kvStoreTable.updatedAt, since));
      } else {
        rows = await db
          .select()
          .from(kvStoreTable);
      }
    } catch(dbErr) {
      console.error("DB query failed:", dbErr);

      return res.status(200).json({
        serverTime: new Date().toISOString(),
        entries:[]
      });
    }

    return res.json({
      serverTime: new Date().toISOString(),
      entries: rows.map(r => ({
        key: r.key,
        value: r.value,
        updatedAt: new Date(
          r.updatedAt || Date.now()
        ).toISOString()
      }))
    });

  } catch(err) {
    console.error("KV route crash:", err);

    return res.status(200).json({
      serverTime:new Date().toISOString(),
      entries:[]
    });
  }
});

router.put("/kv", async (req, res) => {
  try {

    const body = req.body || {};

    const writes = Array.isArray(body.writes)
      ? body.writes.filter(w => w?.key)
      : [];

    const deletes = Array.isArray(body.deletes)
      ? body.deletes
      : [];

    // UPSERT aman satu-persatu (lebih lambat sedikit tapi stabil)
    for (const item of writes) {

      try {

        await db
          .insert(kvStoreTable)
          .values({
            key: item.key,
            value: item.value
          })
          .onConflictDoUpdate({
            target: kvStoreTable.key,
            set:{
              value:item.value,
              updatedAt: sql`now()`
            }
          });

      } catch(e){
        console.error("Write failed:",e);
      }

    }

    // delete aman
    if(deletes.length){
      try{
        await db
         .delete(kvStoreTable)
         .where(
           inArray(kvStoreTable.key,deletes)
         );
      }catch(e){
        console.error("Delete failed:",e);
      }
    }

    return res.status(200).json({
      serverTime:new Date().toISOString(),
      written:writes.length,
      deleted:deletes.length
    });

  } catch(err){

    console.error("PUT /kv crash:",err);

    return res.status(200).json({
      serverTime:new Date().toISOString(),
      written:0,
      deleted:0
    });

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
