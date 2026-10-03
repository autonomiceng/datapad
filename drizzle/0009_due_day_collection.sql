CREATE TABLE "billing_payment_attempts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "deployment_key" text NOT NULL,
  "invoice_id" uuid NOT NULL,
  "group_id" uuid NOT NULL,
  "customer_id" uuid NOT NULL,
  "billing_customer_id" uuid NOT NULL,
  "provider_account_id" text NOT NULL,
  "enrollment_id" uuid NOT NULL,
  "payment_method_id" uuid NOT NULL,
  "charge_at" timestamp with time zone NOT NULL,
  "due_end_at" timestamp with time zone NOT NULL,
  "currency" text NOT NULL,
  "remaining_minor" integer NOT NULL,
  "request" jsonb NOT NULL,
  "request_digest" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "first_attempted_at" timestamp with time zone NOT NULL,
  "baseline_observed_at" timestamp with time zone NOT NULL,
  "baseline_paid_minor" integer NOT NULL,
  "baseline_paid_off_stripe_minor" integer NOT NULL,
  "baseline_overpaid_minor" integer NOT NULL,
  "baseline_payments" jsonb NOT NULL,
  "state" text NOT NULL,
  "reason" text,
  "dispatch_count" integer NOT NULL,
  "inspection_failures" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone,
  "last_dispatched_at" timestamp with time zone NOT NULL,
  "response_at" timestamp with time zone,
  "response_invoice_status" text,
  "response_kind" text,
  "response_payment_intent_id" text,
  "response_invoice_payment_id" text,
  "attributed_invoice_payment_id" text,
  "attributed_payment_intent_id" text,
  "last_checked_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  CONSTRAINT "payment_attempt_invoice" UNIQUE("invoice_id"),
  CONSTRAINT "payment_attempt_key" UNIQUE("deployment_key","idempotency_key"),
  CONSTRAINT "payment_attempt_state" CHECK ("billing_payment_attempts"."state" in ('pending','processing','failed','requires_action','succeeded','needs_review')),
  CONSTRAINT "payment_attempt_money" CHECK ("billing_payment_attempts"."currency"='USD' and "billing_payment_attempts"."remaining_minor" between 1 and 99999999 and "billing_payment_attempts"."baseline_paid_minor" between 0 and 99999999 and "billing_payment_attempts"."baseline_paid_off_stripe_minor" between 0 and 99999999 and "billing_payment_attempts"."baseline_overpaid_minor"=0),
  CONSTRAINT "payment_attempt_calendar" CHECK ("billing_payment_attempts"."charge_at"<"billing_payment_attempts"."due_end_at" and "billing_payment_attempts"."first_attempted_at"<"billing_payment_attempts"."due_end_at" and "billing_payment_attempts"."baseline_observed_at"<="billing_payment_attempts"."first_attempted_at" and "billing_payment_attempts"."last_dispatched_at">="billing_payment_attempts"."first_attempted_at"),
  CONSTRAINT "payment_attempt_budget" CHECK ("billing_payment_attempts"."dispatch_count" between 1 and 5 and "billing_payment_attempts"."inspection_failures" between 0 and 5 and ("billing_payment_attempts"."next_attempt_at" is null or ("billing_payment_attempts"."state" in ('pending','processing') and "billing_payment_attempts"."next_attempt_at">="billing_payment_attempts"."first_attempted_at"))),
  CONSTRAINT "payment_attempt_reason" CHECK (("billing_payment_attempts"."state"='needs_review' and "billing_payment_attempts"."reason" is not null and "billing_payment_attempts"."reason" in ('provider_unavailable','consent_changed','method_unavailable','resolution_conflict','amount_changed','competing_payment','provider_mismatch','uncertain_outcome','retry_exhausted')) or ("billing_payment_attempts"."state"='failed' and "billing_payment_attempts"."reason" is not null and "billing_payment_attempts"."reason"='declined') or ("billing_payment_attempts"."state"='requires_action' and "billing_payment_attempts"."reason" is not null and "billing_payment_attempts"."reason"='authentication_required') or ("billing_payment_attempts"."state" in ('pending','processing','succeeded') and "billing_payment_attempts"."reason" is null)),
  CONSTRAINT "payment_attempt_request" CHECK (jsonb_typeof("billing_payment_attempts"."request")='object' and "billing_payment_attempts"."request"->>'providerInvoiceId' is not null and length("billing_payment_attempts"."request"->>'providerInvoiceId')>0 and "billing_payment_attempts"."request"->>'providerPaymentMethodId' is not null and length("billing_payment_attempts"."request"->>'providerPaymentMethodId')>0 and "billing_payment_attempts"."request"->'offSession'='true'::jsonb and "billing_payment_attempts"."request_digest" ~ '^[0-9a-f]{64}$' and "billing_payment_attempts"."idempotency_key"='datapad:' || "billing_payment_attempts"."deployment_key" || ':payment:' || "billing_payment_attempts"."id"::text || ':pay' and jsonb_typeof("billing_payment_attempts"."baseline_payments")='array'),
  CONSTRAINT "payment_attempt_response" CHECK (("billing_payment_attempts"."response_at" is null and "billing_payment_attempts"."response_kind" is null and "billing_payment_attempts"."response_invoice_status" is null and "billing_payment_attempts"."response_payment_intent_id" is null and "billing_payment_attempts"."response_invoice_payment_id" is null) or ("billing_payment_attempts"."response_at" is not null and "billing_payment_attempts"."response_at">="billing_payment_attempts"."first_attempted_at" and "billing_payment_attempts"."response_kind" is not null and (("billing_payment_attempts"."response_kind"='response' and "billing_payment_attempts"."response_invoice_status" is not null and "billing_payment_attempts"."response_invoice_status" in ('draft','open','paid','void','uncollectible') and (("billing_payment_attempts"."response_payment_intent_id" is null and "billing_payment_attempts"."response_invoice_payment_id" is null) or ("billing_payment_attempts"."response_payment_intent_id" is not null and "billing_payment_attempts"."response_invoice_payment_id" is not null and length("billing_payment_attempts"."response_payment_intent_id")>0 and length("billing_payment_attempts"."response_invoice_payment_id")>0))) or ("billing_payment_attempts"."response_kind" in ('declined','requires_action') and "billing_payment_attempts"."response_invoice_status" is null and "billing_payment_attempts"."response_invoice_payment_id" is null)))),
  CONSTRAINT "payment_attempt_attribution" CHECK (("billing_payment_attempts"."attributed_invoice_payment_id" is null) = ("billing_payment_attempts"."attributed_payment_intent_id" is null) and ("billing_payment_attempts"."state"<>'succeeded' or ("billing_payment_attempts"."response_kind"='response' and "billing_payment_attempts"."response_at" is not null and "billing_payment_attempts"."response_invoice_payment_id" is not null and "billing_payment_attempts"."response_payment_intent_id" is not null and "billing_payment_attempts"."response_invoice_payment_id"="billing_payment_attempts"."attributed_invoice_payment_id" and "billing_payment_attempts"."response_payment_intent_id"="billing_payment_attempts"."attributed_payment_intent_id" and "billing_payment_attempts"."attributed_invoice_payment_id" is not null and "billing_payment_attempts"."attributed_payment_intent_id" is not null and "billing_payment_attempts"."completed_at" is not null)))
);
--> statement-breakpoint
ALTER TABLE "billing_invoice_groups" ADD COLUMN "collection_missed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "collection_state" text;--> statement-breakpoint
ALTER TABLE "billing_payment_attempts" ADD CONSTRAINT "payment_attempt_invoice_owner" FOREIGN KEY ("invoice_id","billing_customer_id","deployment_key") REFERENCES "public"."invoices"("id","billing_customer_id","deployment_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_payment_attempts" ADD CONSTRAINT "payment_attempt_mapping" FOREIGN KEY ("billing_customer_id","customer_id","deployment_key") REFERENCES "public"."billing_customers"("id","customer_id","deployment_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_invoice_groups" ADD CONSTRAINT "invoice_group_collection_owner" UNIQUE("id","customer_id","deployment_key","invoice_id");--> statement-breakpoint
ALTER TABLE "billing_payment_attempts" ADD CONSTRAINT "payment_attempt_group" FOREIGN KEY ("group_id","customer_id","deployment_key","invoice_id") REFERENCES "public"."billing_invoice_groups"("id","customer_id","deployment_key","invoice_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_payment_attempts" ADD CONSTRAINT "payment_attempt_enrollment" FOREIGN KEY ("enrollment_id","customer_id","deployment_key","payment_method_id") REFERENCES "public"."billing_enrollments"("id","customer_id","deployment_key","payment_method_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_payment_attempts" ADD CONSTRAINT "payment_attempt_method" FOREIGN KEY ("payment_method_id","customer_id","deployment_key","billing_customer_id") REFERENCES "public"."billing_payment_methods"("id","customer_id","deployment_key","billing_customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_attempt_pending" ON "billing_payment_attempts" USING btree ("deployment_key","state","next_attempt_at");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoice_collection_state" CHECK ("invoices"."collection_state" is null or "invoices"."collection_state" in ('idle','active','unknown'));
