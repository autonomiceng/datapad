CREATE TABLE "invoice_notices" (
  "id" uuid PRIMARY KEY NOT NULL,
  "deployment_key" text NOT NULL,
  "invoice_id" uuid NOT NULL,
  "billing_customer_id" uuid NOT NULL,
  "customer_id" uuid NOT NULL,
  "stage" text NOT NULL,
  "state" text NOT NULL,
  "reason" text,
  "time_zone" text NOT NULL,
  "hour" integer NOT NULL,
  "scheduled_at" timestamp with time zone,
  "window_end_at" timestamp with time zone,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone,
  "attempted_at" timestamp with time zone,
  "accepted_at" timestamp with time zone,
  "recipient" text,
  "profile_version" integer,
  "preview" jsonb,
  "template_input" jsonb,
  "template_version" integer,
  "message_id" text,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "invoice_notice_stage" UNIQUE("deployment_key","invoice_id","stage"),
  CONSTRAINT "invoice_notice_stage_check" CHECK ("invoice_notices"."stage" in ('invoice','before_due','due','overdue')),
  CONSTRAINT "invoice_notice_state" CHECK ("invoice_notices"."state" in ('pending','sending','accepted','suppressed','needs_review')),
  CONSTRAINT "invoice_notice_hour" CHECK ("invoice_notices"."hour" between 0 and 23),
  CONSTRAINT "invoice_notice_attempts" CHECK ("invoice_notices"."attempts" between 0 and 3),
  CONSTRAINT "invoice_notice_snapshot" CHECK (("invoice_notices"."attempts"=0 and "invoice_notices"."recipient" is null and "invoice_notices"."profile_version" is null and "invoice_notices"."preview" is null and "invoice_notices"."template_input" is null and "invoice_notices"."template_version" is null and "invoice_notices"."message_id" is null and "invoice_notices"."attempted_at" is null) or ("invoice_notices"."attempts">0 and "invoice_notices"."recipient" is not null and "invoice_notices"."profile_version" is not null and "invoice_notices"."profile_version">0 and "invoice_notices"."preview" is not null and "invoice_notices"."template_input" is not null and "invoice_notices"."template_version" is not null and "invoice_notices"."template_version"=1 and "invoice_notices"."message_id" is not null and "invoice_notices"."attempted_at" is not null)),
  CONSTRAINT "invoice_notice_acceptance" CHECK (("invoice_notices"."state"='accepted')=("invoice_notices"."accepted_at" is not null)),
  CONSTRAINT "invoice_notice_sending" CHECK ("invoice_notices"."state" not in ('sending','accepted') or "invoice_notices"."attempts">0),
  CONSTRAINT "invoice_notice_calendar" CHECK ("invoice_notices"."scheduled_at" is not null or ("invoice_notices"."state"='needs_review' and "invoice_notices"."reason" is not null and "invoice_notices"."reason"='calendar_invalid'))
);
--> statement-breakpoint
ALTER TABLE "invoice_notices" ADD CONSTRAINT "invoice_notices_invoice_id_billing_customer_id_deployment_key_invoices_id_billing_customer_id_deployment_key_fk" FOREIGN KEY ("invoice_id","billing_customer_id","deployment_key") REFERENCES "public"."invoices"("id","billing_customer_id","deployment_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_notices" ADD CONSTRAINT "invoice_notices_billing_customer_id_customer_id_deployment_key_billing_customers_id_customer_id_deployment_key_fk" FOREIGN KEY ("billing_customer_id","customer_id","deployment_key") REFERENCES "public"."billing_customers"("id","customer_id","deployment_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_notice_pending" ON "invoice_notices" USING btree ("deployment_key","state","next_attempt_at","created_at","id");
