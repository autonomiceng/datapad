ALTER TABLE "billing_customers" ADD CONSTRAINT "billing_customer_account_scope" UNIQUE("id","customer_id","deployment_key");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoice_customer_scope" UNIQUE("id","billing_customer_id","deployment_key");--> statement-breakpoint
CREATE TABLE "billing_invoice_groups" (
  "id" uuid PRIMARY KEY NOT NULL,
  "customer_id" uuid NOT NULL,
  "deployment_key" text NOT NULL,
  "due_date" date NOT NULL,
  "currency" text NOT NULL,
  "payment_arrangement" text NOT NULL,
  "calendar" jsonb NOT NULL,
  "outcome" text NOT NULL,
  "sealed_at" timestamp with time zone NOT NULL,
  "total_minor" integer NOT NULL,
  "bill_to_name" text NOT NULL,
  "bill_to_email" text,
  "bill_to_profile_version" integer NOT NULL,
  "billing_customer_id" uuid,
  "invoice_id" uuid,
  CONSTRAINT "invoice_group_scope" UNIQUE("id","customer_id","deployment_key"),
  CONSTRAINT "invoice_group_date" UNIQUE("customer_id","deployment_key","due_date","currency","payment_arrangement"),
  CONSTRAINT "invoice_group_invoice" UNIQUE("invoice_id"),
  CONSTRAINT "invoice_group_currency" CHECK ("billing_invoice_groups"."currency"='USD'),
  CONSTRAINT "invoice_group_arrangement" CHECK ("billing_invoice_groups"."payment_arrangement" in ('manual','automatic')),
  CONSTRAINT "invoice_group_bill_to" CHECK ("billing_invoice_groups"."bill_to_profile_version">0 and length(trim("billing_invoice_groups"."bill_to_name")) between 1 and 256),
  CONSTRAINT "invoice_group_outcome" CHECK (("billing_invoice_groups"."outcome"='invoice_requested' and "billing_invoice_groups"."total_minor" between 50 and 99999999 and "billing_invoice_groups"."billing_customer_id" is not null and "billing_invoice_groups"."invoice_id" is not null) or ("billing_invoice_groups"."outcome"='no_charge' and "billing_invoice_groups"."total_minor"=0 and "billing_invoice_groups"."billing_customer_id" is null and "billing_invoice_groups"."invoice_id" is null))
);
--> statement-breakpoint
CREATE TABLE "billing_schedules" (
  "customer_id" uuid NOT NULL,
  "deployment_key" text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "issuance_paused" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "created_by" text NOT NULL,
  "updated_by" text NOT NULL,
  CONSTRAINT "billing_schedules_customer_id_deployment_key_pk" PRIMARY KEY("customer_id","deployment_key"),
  CONSTRAINT "billing_schedule_version" CHECK ("billing_schedules"."version">0)
);
--> statement-breakpoint
ALTER TABLE "invoice_lines" DROP CONSTRAINT "invoice_line_amount";--> statement-breakpoint
ALTER TABLE "billing_periods" ADD COLUMN "invoice_group_id" uuid;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "activation_from_period_index" integer;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "activated_by" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "issue_not_before" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "first_attempt_before" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "due_end_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "calendar" jsonb;--> statement-breakpoint
UPDATE "invoices" SET
  "issue_not_before" = "issue_date"::timestamp AT TIME ZONE 'UTC',
  "first_attempt_before" = "due_date"::timestamp AT TIME ZONE 'UTC',
  "due_end_at" = ("due_date"::timestamp + interval '23 hours 59 minutes 59 seconds') AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "issue_not_before" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "first_attempt_before" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "due_end_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_invoice_groups" ADD CONSTRAINT "invoice_group_schedule" FOREIGN KEY ("customer_id","deployment_key") REFERENCES "public"."billing_schedules"("customer_id","deployment_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_invoice_groups" ADD CONSTRAINT "invoice_group_mapping" FOREIGN KEY ("billing_customer_id","customer_id","deployment_key") REFERENCES "public"."billing_customers"("id","customer_id","deployment_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_invoice_groups" ADD CONSTRAINT "invoice_group_invoice_owner" FOREIGN KEY ("invoice_id","billing_customer_id","deployment_key") REFERENCES "public"."invoices"("id","billing_customer_id","deployment_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_schedules" ADD CONSTRAINT "billing_schedules_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_schedule_scan" ON "billing_schedules" USING btree ("deployment_key","created_at","customer_id");--> statement-breakpoint
ALTER TABLE "billing_periods" ADD CONSTRAINT "billing_period_invoice_group" FOREIGN KEY ("invoice_group_id","customer_id","deployment_key") REFERENCES "public"."billing_invoice_groups"("id","customer_id","deployment_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_periods" ADD CONSTRAINT "billing_period_sealed_claim" CHECK ("billing_periods"."invoice_group_id" IS NULL OR "billing_periods"."sealed_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "subscription_activation" CHECK (("billing_subscriptions"."activation_from_period_index" IS NULL AND "billing_subscriptions"."activated_at" IS NULL AND "billing_subscriptions"."activated_by" IS NULL) OR ("billing_subscriptions"."activation_from_period_index" IS NOT NULL AND "billing_subscriptions"."activated_at" IS NOT NULL AND "billing_subscriptions"."activated_by" IS NOT NULL AND "billing_subscriptions"."activation_from_period_index" BETWEEN "billing_subscriptions"."first_unbilled_period_index" AND 120000));--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_line_amount" CHECK ("invoice_lines"."amount_minor" BETWEEN 0 AND 99999999);--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoice_effect_window" CHECK ("invoices"."issue_not_before"<"invoices"."first_attempt_before" AND "invoices"."first_attempt_before"<="invoices"."due_end_at");
