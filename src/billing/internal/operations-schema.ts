import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const billingEffectControls = pgTable(
  "billing_effect_controls",
  {
    deploymentKey: text("deployment_key").primaryKey(),
    paused: boolean("paused").notNull().default(true),
    version: integer("version").notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (t) => [check("billing_effect_control_version", sql`${t.version} > 0`)],
);
