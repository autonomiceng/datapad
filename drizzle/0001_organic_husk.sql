CREATE TABLE "billing_customers" (
  "id" uuid PRIMARY KEY NOT NULL,
  "deployment_key" text NOT NULL,
  "provider_account_id" text NOT NULL,
  "key" text NOT NULL,
  "name" text NOT NULL,
  "provider_customer_id" text,
  "create_attempted_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "billing_customer_scope" UNIQUE("id","deployment_key")
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
  "id" uuid PRIMARY KEY NOT NULL,
  "invoice_id" uuid NOT NULL,
  "position" integer NOT NULL,
  "description" text NOT NULL,
  "amount_minor" integer NOT NULL,
  "origin_ref" text,
  "provider_line_id" text,
  "create_attempted_at" timestamp with time zone,
  CONSTRAINT "invoice_line_amount" CHECK ("invoice_lines"."amount_minor" BETWEEN 1 AND 99999999),
  CONSTRAINT "invoice_line_position_range" CHECK ("invoice_lines"."position" BETWEEN 0 AND 99)
);
--> statement-breakpoint
CREATE TABLE "invoices" (
  "id" uuid PRIMARY KEY NOT NULL,
  "deployment_key" text NOT NULL,
  "origin_key" text NOT NULL,
  "request_digest" text NOT NULL,
  "customer_id" uuid NOT NULL,
  "issue_date" date NOT NULL,
  "due_date" date NOT NULL,
  "readiness_date" date NOT NULL,
  "currency" text NOT NULL,
  "total_minor" integer NOT NULL,
  "state" text NOT NULL,
  "provider_invoice_id" text,
  "provider_status" text,
  "hosted_invoice_url" text,
  "issued_at" timestamp with time zone,
  "issue_requested_at" timestamp with time zone,
  "create_attempted_at" timestamp with time zone,
  "finalize_attempted_at" timestamp with time zone,
  "last_checked_at" timestamp with time zone,
  "review_reason" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "invoice_currency" CHECK ("invoices"."currency" = 'USD'),
  CONSTRAINT "invoice_total" CHECK ("invoices"."total_minor" BETWEEN 50 AND 99999999),
  CONSTRAINT "invoice_readiness" CHECK ("invoices"."readiness_date" = "invoices"."due_date" - 21),
  CONSTRAINT "invoice_dates" CHECK ("invoices"."issue_date" >= "invoices"."readiness_date" AND "invoices"."issue_date" < "invoices"."due_date"),
  CONSTRAINT "invoice_state" CHECK ("invoices"."state" IN ('requested', 'preparing', 'needs_review', 'draft', 'open', 'paid', 'void', 'uncollectible')),
  CONSTRAINT "invoice_provider_status" CHECK ("invoices"."provider_status" IS NULL OR "invoices"."provider_status" IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
  CONSTRAINT "invoice_review_reason" CHECK (("invoices"."state" = 'needs_review') = ("invoices"."review_reason" IS NOT NULL)),
  CONSTRAINT "invoice_attempts" CHECK ("invoices"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
  "event_id" text PRIMARY KEY NOT NULL,
  "deployment_key" text NOT NULL,
  "provider_account_id" text NOT NULL,
  "event_type" text NOT NULL,
  "provider_invoice_id" text NOT NULL,
  "invoice_id" uuid,
  "created_at" timestamp with time zone NOT NULL,
  "received_at" timestamp with time zone NOT NULL,
  "processed_at" timestamp with time zone,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone,
  "last_error" text,
  CONSTRAINT "stripe_event_attempts" CHECK ("stripe_events"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_deployment_key_billing_customers_id_deployment_key_fk" FOREIGN KEY ("customer_id","deployment_key") REFERENCES "public"."billing_customers"("id","deployment_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_customer_key" ON "billing_customers" USING btree ("deployment_key","key");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_customer_provider_id" ON "billing_customers" USING btree ("provider_account_id","provider_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_line_position" ON "invoice_lines" USING btree ("invoice_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_line_provider_id" ON "invoice_lines" USING btree ("invoice_id","provider_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_origin" ON "invoices" USING btree ("deployment_key","origin_key");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_provider_id" ON "invoices" USING btree ("deployment_key","provider_invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_pending" ON "invoices" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "stripe_event_pending" ON "stripe_events" USING btree ("processed_at","next_attempt_at");
