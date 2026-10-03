CREATE TABLE "billing_enrollment_noops" (
  "deployment_key" text NOT NULL,
  "request_id" uuid NOT NULL,
  "customer_id" uuid NOT NULL,
  "enrollment_id" uuid NOT NULL,
  "request_digest" text NOT NULL,
  "request" jsonb NOT NULL,
  CONSTRAINT "billing_enrollment_noops_deployment_key_request_id_pk" PRIMARY KEY("deployment_key","request_id")
);
--> statement-breakpoint
CREATE TABLE "billing_enrollment_scopes" (
  "enrollment_id" uuid NOT NULL,
  "customer_id" uuid NOT NULL,
  "deployment_key" text NOT NULL,
  "subscription_id" uuid NOT NULL,
  "commercial_revision" integer NOT NULL,
  "from_period_index" integer NOT NULL,
  "until_period_index" integer,
  "period_start" date NOT NULL,
  "due_date" date NOT NULL,
  "calendar" jsonb NOT NULL,
  CONSTRAINT "billing_enrollment_scopes_enrollment_id_subscription_id_pk" PRIMARY KEY("enrollment_id","subscription_id"),
  CONSTRAINT "enrollment_scope_range" CHECK ("billing_enrollment_scopes"."from_period_index" between 0 and 120000 and ("billing_enrollment_scopes"."until_period_index" is null or "billing_enrollment_scopes"."until_period_index">"billing_enrollment_scopes"."from_period_index" and "billing_enrollment_scopes"."until_period_index"<=120000))
);
--> statement-breakpoint
CREATE TABLE "billing_enrollments" (
  "id" uuid PRIMARY KEY NOT NULL,
  "customer_id" uuid NOT NULL,
  "deployment_key" text NOT NULL,
  "version" integer NOT NULL,
  "request_id" uuid NOT NULL,
  "request_digest" text NOT NULL,
  "request" jsonb NOT NULL,
  "predecessor_id" uuid,
  "decision" text NOT NULL,
  "actor_user_id" text NOT NULL,
  "actor_session_id" text NOT NULL,
  "consenting_membership_id" text NOT NULL,
  "membership_provenance" jsonb NOT NULL,
  "accepted_at" timestamp with time zone NOT NULL,
  "terms_version" text NOT NULL,
  "terms_digest" text NOT NULL,
  "payment_method_id" uuid,
  CONSTRAINT "enrollment_version" UNIQUE("customer_id","deployment_key","version"),
  CONSTRAINT "enrollment_request" UNIQUE("deployment_key","request_id"),
  CONSTRAINT "enrollment_owner" UNIQUE("id","customer_id","deployment_key"),
  CONSTRAINT "enrollment_method_owner" UNIQUE("id","customer_id","deployment_key","payment_method_id"),
  CONSTRAINT "enrollment_sequence" CHECK ("billing_enrollments"."version">0 and (("billing_enrollments"."version"=1 and "billing_enrollments"."predecessor_id" is null) or ("billing_enrollments"."version">1 and "billing_enrollments"."predecessor_id" is not null))),
  CONSTRAINT "enrollment_decision" CHECK ("billing_enrollments"."decision" in ('authorize','reduce'))
);
--> statement-breakpoint
CREATE TABLE "billing_payment_methods" (
  "id" uuid PRIMARY KEY NOT NULL,
  "customer_id" uuid NOT NULL,
  "deployment_key" text NOT NULL,
  "billing_customer_id" uuid NOT NULL,
  "provider_account_id" text NOT NULL,
  "setup_id" uuid NOT NULL,
  "provider_payment_method_id" text NOT NULL,
  "brand" text NOT NULL,
  "last4" text NOT NULL,
  "expiry_month" integer NOT NULL,
  "expiry_year" integer NOT NULL,
  "verified_at" timestamp with time zone NOT NULL,
  CONSTRAINT "payment_method_receipt" UNIQUE("provider_account_id","provider_payment_method_id"),
  CONSTRAINT "payment_method_owner" UNIQUE("id","customer_id","deployment_key"),
  CONSTRAINT "payment_method_mapping_owner" UNIQUE("id","customer_id","deployment_key","billing_customer_id"),
  CONSTRAINT "payment_method_card" CHECK (length("billing_payment_methods"."brand") between 1 and 32 and "billing_payment_methods"."last4" ~ '^[0-9]{4}$' and "billing_payment_methods"."expiry_month" between 1 and 12 and "billing_payment_methods"."expiry_year" between 2000 and 9999)
);
--> statement-breakpoint
CREATE TABLE "billing_payment_setups" (
  "id" uuid PRIMARY KEY NOT NULL,
  "customer_id" uuid NOT NULL,
  "deployment_key" text NOT NULL,
  "billing_customer_id" uuid NOT NULL,
  "provider_account_id" text NOT NULL,
  "request_id" uuid NOT NULL,
  "request_digest" text NOT NULL,
  "actor_user_id" text NOT NULL,
  "actor_session_id" text NOT NULL,
  "consenting_membership_id" text NOT NULL,
  "membership_provenance" jsonb NOT NULL,
  "save_terms_version" text NOT NULL,
  "save_terms_digest" text NOT NULL,
  "accepted_at" timestamp with time zone NOT NULL,
  "success_url" text NOT NULL,
  "cancel_url" text NOT NULL,
  "integration_identifier" text NOT NULL,
  "create_attempted_at" timestamp with time zone,
  "provider_session_id" text,
  "provider_setup_intent_id" text,
  "provider_payment_method_id" text,
  "pending_session_id" text,
  "checkout_url" text,
  "status" text NOT NULL,
  "retrieval_requested_at" timestamp with time zone NOT NULL,
  "last_checked_at" timestamp with time zone,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone,
  CONSTRAINT "payment_setup_request" UNIQUE("deployment_key","request_id"),
  CONSTRAINT "payment_setup_receipt" UNIQUE("provider_account_id","provider_session_id"),
  CONSTRAINT "payment_setup_intent_receipt" UNIQUE("provider_account_id","provider_setup_intent_id"),
  CONSTRAINT "payment_setup_owner" UNIQUE("id","customer_id","deployment_key","billing_customer_id","provider_account_id"),
  CONSTRAINT "payment_setup_status" CHECK ("billing_payment_setups"."status" in ('pending','verified','expired','needs_review')),
  CONSTRAINT "payment_setup_attempts" CHECK ("billing_payment_setups"."attempts" between 0 and 5)
);
--> statement-breakpoint
ALTER TABLE "billing_invoice_groups" ADD COLUMN "enrollment_id" uuid;--> statement-breakpoint
ALTER TABLE "billing_invoice_groups" ADD COLUMN "payment_method_id" uuid;--> statement-breakpoint
ALTER TABLE "billing_enrollment_noops" ADD CONSTRAINT "enrollment_noop_owner" FOREIGN KEY ("enrollment_id","customer_id","deployment_key") REFERENCES "public"."billing_enrollments"("id","customer_id","deployment_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_enrollment_scopes" ADD CONSTRAINT "enrollment_scope_owner" FOREIGN KEY ("enrollment_id","customer_id","deployment_key") REFERENCES "public"."billing_enrollments"("id","customer_id","deployment_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_enrollment_scopes" ADD CONSTRAINT "enrollment_scope_subscription" FOREIGN KEY ("subscription_id","customer_id","deployment_key") REFERENCES "public"."billing_subscriptions"("id","customer_id","deployment_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_enrollment_scopes" ADD CONSTRAINT "enrollment_scope_revision" FOREIGN KEY ("subscription_id","customer_id","deployment_key","commercial_revision") REFERENCES "public"."billing_subscription_terms"("subscription_id","customer_id","deployment_key","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_enrollments" ADD CONSTRAINT "billing_enrollments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_enrollments" ADD CONSTRAINT "enrollment_method" FOREIGN KEY ("payment_method_id","customer_id","deployment_key") REFERENCES "public"."billing_payment_methods"("id","customer_id","deployment_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_enrollments" ADD CONSTRAINT "enrollment_predecessor" FOREIGN KEY ("predecessor_id","customer_id","deployment_key") REFERENCES "public"."billing_enrollments"("id","customer_id","deployment_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_payment_methods" ADD CONSTRAINT "payment_method_setup" FOREIGN KEY ("setup_id","customer_id","deployment_key","billing_customer_id","provider_account_id") REFERENCES "public"."billing_payment_setups"("id","customer_id","deployment_key","billing_customer_id","provider_account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_payment_setups" ADD CONSTRAINT "payment_setup_mapping" FOREIGN KEY ("billing_customer_id","customer_id","deployment_key") REFERENCES "public"."billing_customers"("id","customer_id","deployment_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_setup_pending" ON "billing_payment_setups" USING btree ("deployment_key","status","next_attempt_at");--> statement-breakpoint
ALTER TABLE "billing_invoice_groups" ADD CONSTRAINT "invoice_group_enrollment" FOREIGN KEY ("enrollment_id","customer_id","deployment_key","payment_method_id") REFERENCES "public"."billing_enrollments"("id","customer_id","deployment_key","payment_method_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_invoice_groups" ADD CONSTRAINT "invoice_group_method" FOREIGN KEY ("payment_method_id","customer_id","deployment_key","billing_customer_id") REFERENCES "public"."billing_payment_methods"("id","customer_id","deployment_key","billing_customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_invoice_groups" ADD CONSTRAINT "invoice_group_permission_pair" CHECK (("billing_invoice_groups"."enrollment_id" is null and "billing_invoice_groups"."payment_method_id" is null) or ("billing_invoice_groups"."enrollment_id" is not null and "billing_invoice_groups"."payment_method_id" is not null and "billing_invoice_groups"."payment_arrangement"='automatic' and "billing_invoice_groups"."total_minor">0));
