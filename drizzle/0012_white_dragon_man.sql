ALTER TABLE "service_components" ADD CONSTRAINT "service_component_service_customer" UNIQUE("id","service_id","customer_id");
--> statement-breakpoint
CREATE TABLE "support_approvals" (
  "id" uuid PRIMARY KEY NOT NULL,
  "ticket_id" uuid NOT NULL,
  "customer_id" uuid NOT NULL,
  "proposal_id" uuid NOT NULL,
  "proposal_version" integer NOT NULL,
  "approved_by_user_id" text NOT NULL,
  "session_id" text NOT NULL,
  "membership_id" text NOT NULL,
  "invitation_id" text,
  "invited_by_user_id" text,
  "invited_by_staff" boolean,
  "staff_roles" jsonb NOT NULL,
  "approved_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "support_approvals_proposal_id_unique" UNIQUE("proposal_id"),
  CONSTRAINT "support_approval_not_self_invited" CHECK ("support_approvals"."invited_by_user_id" is null or "support_approvals"."invited_by_user_id" <> "support_approvals"."approved_by_user_id")
);
--> statement-breakpoint
CREATE TABLE "support_entries" (
  "id" uuid PRIMARY KEY NOT NULL,
  "ticket_id" uuid NOT NULL,
  "customer_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "body" text NOT NULL,
  "author_user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "result" jsonb,
  "proposal_id" uuid,
  "proposal_version" integer,
  CONSTRAINT "support_entry_body" CHECK (length(trim("support_entries"."body")) between 1 and 10000),
  CONSTRAINT "support_entry_kind" CHECK ("support_entries"."kind" in ('reply','note','result')),
  CONSTRAINT "support_entry_result" CHECK (("support_entries"."kind" = 'result' and "support_entries"."result" is not null and (("support_entries"."result"->>'outcome' = 'completed' and "support_entries"."proposal_id" is not null and "support_entries"."proposal_version" is not null) or ("support_entries"."result"->>'outcome' = 'unchanged' and "support_entries"."proposal_id" is null and "support_entries"."proposal_version" is null))) or ("support_entries"."kind" <> 'result' and "support_entries"."result" is null and "support_entries"."proposal_id" is null and "support_entries"."proposal_version" is null))
);
--> statement-breakpoint
CREATE TABLE "support_proposals" (
  "id" uuid PRIMARY KEY NOT NULL,
  "ticket_id" uuid NOT NULL,
  "customer_id" uuid NOT NULL,
  "service_id" uuid NOT NULL,
  "component_id" uuid,
  "version" integer NOT NULL,
  "prepared_by_user_id" text NOT NULL,
  "action" text NOT NULL,
  "cost" jsonb NOT NULL,
  "data_effect" jsonb NOT NULL,
  "target" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "support_proposal_revision" UNIQUE("ticket_id","version"),
  CONSTRAINT "support_proposal_customer_revision" UNIQUE("id","ticket_id","customer_id","version"),
  CONSTRAINT "support_proposal_version" CHECK ("support_proposals"."version" > 0),
  CONSTRAINT "support_proposal_action" CHECK (length(trim("support_proposals"."action")) between 1 and 2000),
  CONSTRAINT "support_proposal_target" CHECK (("support_proposals"."target"->'service'->>'id')::uuid = "support_proposals"."service_id" and ("support_proposals"."target"->'component'->>'id')::uuid is not distinct from "support_proposals"."component_id")
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
  "id" uuid PRIMARY KEY NOT NULL,
  "customer_id" uuid NOT NULL,
  "service_id" uuid NOT NULL,
  "component_id" uuid,
  "subject" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "opened_by_user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "support_ticket_customer" UNIQUE("id","customer_id"),
  CONSTRAINT "support_ticket_service" UNIQUE("id","customer_id","service_id"),
  CONSTRAINT "support_ticket_component" UNIQUE("id","customer_id","service_id","component_id"),
  CONSTRAINT "support_ticket_version" CHECK ("support_tickets"."version" > 0),
  CONSTRAINT "support_ticket_subject" CHECK (length(trim("support_tickets"."subject")) between 1 and 256),
  CONSTRAINT "support_ticket_status" CHECK ("support_tickets"."status" in ('open','resolved'))
);
--> statement-breakpoint
ALTER TABLE "support_approvals" ADD CONSTRAINT "support_approval_exact_proposal" FOREIGN KEY ("proposal_id","ticket_id","customer_id","proposal_version") REFERENCES "public"."support_proposals"("id","ticket_id","customer_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_entries" ADD CONSTRAINT "support_entry_ticket_customer" FOREIGN KEY ("ticket_id","customer_id") REFERENCES "public"."support_tickets"("id","customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_entries" ADD CONSTRAINT "support_result_exact_proposal" FOREIGN KEY ("proposal_id","ticket_id","customer_id","proposal_version") REFERENCES "public"."support_proposals"("id","ticket_id","customer_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_proposals" ADD CONSTRAINT "support_proposal_ticket_service" FOREIGN KEY ("ticket_id","customer_id","service_id") REFERENCES "public"."support_tickets"("id","customer_id","service_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_proposals" ADD CONSTRAINT "support_proposal_ticket_component" FOREIGN KEY ("ticket_id","customer_id","service_id","component_id") REFERENCES "public"."support_tickets"("id","customer_id","service_id","component_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_ticket_service_customer" FOREIGN KEY ("service_id","customer_id") REFERENCES "public"."services"("id","customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_ticket_component_customer" FOREIGN KEY ("component_id","service_id","customer_id") REFERENCES "public"."service_components"("id","service_id","customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_entry_thread" ON "support_entries" USING btree ("customer_id","ticket_id","created_at","id");--> statement-breakpoint
CREATE INDEX "support_ticket_activity" ON "support_tickets" USING btree ("customer_id","updated_at","id");--> statement-breakpoint
