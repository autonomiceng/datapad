import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  uuid,
  integer,
  timestamp,
  check,
} from "drizzle-orm/pg-core";
import { organization } from "../../access/schema";
export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey(),
    registryKey: text("registry_key").notNull().unique(),
    organizationId: text("organization_id")
      .unique()
      .references(() => organization.id),
    displayName: text("display_name").notNull(),
    legalName: text("legal_name").notNull(),
    billingEmail: text("billing_email"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("customer_version", sql`${t.version} > 0`),
    check(
      "customer_names",
      sql`length(trim(${t.displayName})) between 1 and 256 and length(trim(${t.legalName})) between 1 and 256`,
    ),
  ],
);
