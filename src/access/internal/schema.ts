import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  uuid,
  timestamp,
  jsonb,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
export * from "./auth-schema";

export const staffGrants = pgTable(
  "access_staff_grants",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.role] }),
    check(
      "access_staff_role",
      sql`${t.role} in ('account_administrator','billing','support')`,
    ),
  ],
);

export const auditEntries = pgTable("access_audit", {
  id: uuid("id").primaryKey(),
  requestId: uuid("request_id"),
  actorId: text("actor_id").notNull(),
  sessionId: text("session_id"),
  customerId: uuid("customer_id"),
  action: text("action").notNull(),
  targetId: text("target_id").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Fixed identity/receipt for invitation and revocation commands, never session credentials. */
export const accessCommands = pgTable(
  "access_commands",
  {
    requestId: uuid("request_id").primaryKey(),
    actorId: text("actor_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    action: text("action").notNull(),
    inputHash: text("input_hash").notNull(),
    invitationId: text("invitation_id"),
    targetId: text("target_id").notNull(),
    state: text("state")
      .$type<"pending" | "completed" | "needs_review">()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "access_command_action",
      sql`${t.action} in ('invitation.create','invitation.accept','invitation.revoke','member.revoke')`,
    ),
    check(
      "access_command_state",
      sql`${t.state} in ('pending','completed','needs_review')`,
    ),
  ],
);
