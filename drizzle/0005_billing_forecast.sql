ALTER TABLE "services" ADD CONSTRAINT "service_customer" UNIQUE("id","customer_id");--> statement-breakpoint
CREATE TABLE "billing_periods" (
  "id" uuid PRIMARY KEY NOT NULL,
  "subscription_id" uuid NOT NULL,
  "customer_id" uuid NOT NULL,
  "deployment_key" text NOT NULL,
  "period_index" integer NOT NULL,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "due_date" date NOT NULL,
  "commercial_revision" integer NOT NULL,
  "state_revision" integer NOT NULL,
  "label" text NOT NULL,
  "amount_minor" integer NOT NULL,
  "currency" text NOT NULL,
  "payment_arrangement" text NOT NULL,
  "billing_state" text NOT NULL,
  "calendar" jsonb NOT NULL,
  "readiness_date" date NOT NULL,
  "issue_at" timestamp with time zone,
  "due_end_at" timestamp with time zone,
  "charge_at" timestamp with time zone,
  "sealed_at" timestamp with time zone,
  CONSTRAINT "billing_period_identity" UNIQUE("subscription_id","period_index"),
  CONSTRAINT "billing_period_index" CHECK ("billing_periods"."period_index" between 0 and 120000),
  CONSTRAINT "billing_period_dates" CHECK ("billing_periods"."period_start"<"billing_periods"."period_end" and "billing_periods"."readiness_date"="billing_periods"."due_date"-21),
  CONSTRAINT "billing_period_money" CHECK ("billing_periods"."currency"='USD' and "billing_periods"."amount_minor" between -99999999 and 99999999),
  CONSTRAINT "billing_period_arrangement" CHECK ("billing_periods"."payment_arrangement" in ('manual','automatic')),
  CONSTRAINT "billing_period_state" CHECK ("billing_periods"."billing_state" in ('billable','paused','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "billing_subscription_terms" (
  "subscription_id" uuid NOT NULL,
  "customer_id" uuid NOT NULL,
  "deployment_key" text NOT NULL,
  "revision" integer NOT NULL,
  "effective_period_index" integer NOT NULL,
  "kind" text NOT NULL,
  "label" text,
  "amount_minor" integer,
  "currency" text,
  "payment_arrangement" text,
  "billing_state" text,
  CONSTRAINT "subscription_terms_revision" UNIQUE("subscription_id","revision"),
  CONSTRAINT "subscription_terms_scope" UNIQUE("subscription_id","customer_id","deployment_key","revision"),
  CONSTRAINT "subscription_terms_bounds" CHECK ("billing_subscription_terms"."revision">0 and "billing_subscription_terms"."effective_period_index" between 0 and 120000),
  CONSTRAINT "subscription_terms_union" CHECK (("billing_subscription_terms"."kind"='commercial' and "billing_subscription_terms"."label" is not null and length(trim("billing_subscription_terms"."label")) between 1 and 256 and "billing_subscription_terms"."amount_minor" is not null and "billing_subscription_terms"."amount_minor" between -99999999 and 99999999 and "billing_subscription_terms"."currency" is not null and "billing_subscription_terms"."currency"='USD' and "billing_subscription_terms"."payment_arrangement" is not null and "billing_subscription_terms"."payment_arrangement" in ('manual','automatic') and "billing_subscription_terms"."billing_state" is null) or ("billing_subscription_terms"."kind"='state' and "billing_subscription_terms"."label" is null and "billing_subscription_terms"."amount_minor" is null and "billing_subscription_terms"."currency" is null and "billing_subscription_terms"."payment_arrangement" is null and "billing_subscription_terms"."billing_state" is not null and "billing_subscription_terms"."billing_state" in ('billable','paused','cancelled')))
);
--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "deployment_key" text NOT NULL,
  "customer_id" uuid NOT NULL,
  "service_id" uuid,
  "create_request_id" uuid NOT NULL,
  "create_digest" text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "period_anchor_date" date NOT NULL,
  "due_anchor_date" date NOT NULL,
  "interval_months" integer NOT NULL,
  "first_unbilled_period_index" integer NOT NULL,
  "calendar" jsonb NOT NULL,
  "cancellation_status" text DEFAULT 'none' NOT NULL,
  "cancellation_reason" text,
  "cancellation_effective_period_index" integer,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "subscription_scope" UNIQUE("id","customer_id","deployment_key"),
  CONSTRAINT "subscription_create_request" UNIQUE("deployment_key","create_request_id"),
  CONSTRAINT "subscription_interval" CHECK ("billing_subscriptions"."interval_months" in (1,3,6,12,24,36)),
  CONSTRAINT "subscription_first_index" CHECK ("billing_subscriptions"."first_unbilled_period_index" between 0 and 120000),
  CONSTRAINT "subscription_version" CHECK ("billing_subscriptions"."version">0),
  CONSTRAINT "subscription_cancel" CHECK ("billing_subscriptions"."cancellation_status" in ('none','requested','declined','approved') and (("billing_subscriptions"."cancellation_status"='none' and "billing_subscriptions"."cancellation_reason" is null) or ("billing_subscriptions"."cancellation_status"<>'none' and "billing_subscriptions"."cancellation_reason" is not null)) and (("billing_subscriptions"."cancellation_status"='approved' and "billing_subscriptions"."cancellation_effective_period_index" is not null and "billing_subscriptions"."cancellation_effective_period_index" >= "billing_subscriptions"."first_unbilled_period_index" and "billing_subscriptions"."cancellation_effective_period_index" <= 120000) or ("billing_subscriptions"."cancellation_status"<>'approved' and "billing_subscriptions"."cancellation_effective_period_index" is null)))
);
--> statement-breakpoint
ALTER TABLE "billing_periods" ADD CONSTRAINT "billing_period_owner" FOREIGN KEY ("subscription_id","customer_id","deployment_key") REFERENCES "public"."billing_subscriptions"("id","customer_id","deployment_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_periods" ADD CONSTRAINT "billing_period_commercial_terms" FOREIGN KEY ("subscription_id","customer_id","deployment_key","commercial_revision") REFERENCES "public"."billing_subscription_terms"("subscription_id","customer_id","deployment_key","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_periods" ADD CONSTRAINT "billing_period_state_terms" FOREIGN KEY ("subscription_id","customer_id","deployment_key","state_revision") REFERENCES "public"."billing_subscription_terms"("subscription_id","customer_id","deployment_key","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscription_terms" ADD CONSTRAINT "subscription_terms_owner" FOREIGN KEY ("subscription_id","customer_id","deployment_key") REFERENCES "public"."billing_subscriptions"("id","customer_id","deployment_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "subscription_service_customer" FOREIGN KEY ("service_id","customer_id") REFERENCES "public"."services"("id","customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_period_due" ON "billing_periods" USING btree ("deployment_key","customer_id","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_one_cancellation" ON "billing_subscription_terms" USING btree ("subscription_id") WHERE "billing_subscription_terms"."billing_state"='cancelled';--> statement-breakpoint
CREATE INDEX "subscription_terms_effective" ON "billing_subscription_terms" USING btree ("subscription_id","kind","effective_period_index","revision");--> statement-breakpoint
