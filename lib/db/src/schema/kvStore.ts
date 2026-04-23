import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const kvStoreTable = pgTable("kv_store", {
  key: text("key").primaryKey(),
  value: text("value"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type KvEntry = typeof kvStoreTable.$inferSelect;
export type NewKvEntry = typeof kvStoreTable.$inferInsert;
