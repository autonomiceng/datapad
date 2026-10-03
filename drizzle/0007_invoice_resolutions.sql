CREATE TABLE "billing_invoice_resolutions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "deployment_key" text NOT NULL,
  "invoice_id" uuid NOT NULL,
  "billing_customer_id" uuid NOT NULL,
  "customer_id" uuid NOT NULL,
  "request_id" uuid NOT NULL,
  "actor_id" text NOT NULL,
  "session_id" text NOT NULL,
  "kind" text NOT NULL,
  "state" text NOT NULL,
  "amount_minor" integer,
  "received_date" date,
  "method" text,
  "reference" text,
  "reason" text,
  "created_at" timestamp with time zone NOT NULL,
  "attempted_at" timestamp with time zone,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone,
  "confirmed_at" timestamp with time zone,
  "review_reason" text,
  "baseline_at" timestamp with time zone,
  "baseline_remaining_minor" integer,
  "baseline_paid_off_stripe_minor" integer,
  "baseline_payments" jsonb,
  "response_at" timestamp with time zone,
  "response_paid_off_stripe_minor" integer,
  "last_checked_at" timestamp with time zone,
  "last_remaining_minor" integer,
  "last_collection_state" text,
  CONSTRAINT "invoice_resolution_kind" CHECK ("billing_invoice_resolutions"."kind" IN ('external_payment','void')),
  CONSTRAINT "invoice_resolution_state" CHECK ("billing_invoice_resolutions"."state" IN ('pending','confirmed','needs_review','withdrawn')),
  CONSTRAINT "invoice_resolution_actor" CHECK (length(btrim("billing_invoice_resolutions"."actor_id"))>0 AND length(btrim("billing_invoice_resolutions"."session_id"))>0),
  CONSTRAINT "invoice_resolution_facts" CHECK ((
    "billing_invoice_resolutions"."kind"='external_payment' AND "billing_invoice_resolutions"."amount_minor" IS NOT NULL AND "billing_invoice_resolutions"."amount_minor" BETWEEN 1 AND 99999999
    AND "billing_invoice_resolutions"."received_date" IS NOT NULL AND "billing_invoice_resolutions"."received_date" <= ("billing_invoice_resolutions"."created_at" AT TIME ZONE 'UTC')::date
    AND "billing_invoice_resolutions"."method" IS NOT NULL AND "billing_invoice_resolutions"."method" IN ('zelle','check')
    AND "billing_invoice_resolutions"."reference" IS NOT NULL AND length(btrim("billing_invoice_resolutions"."reference")) BETWEEN 1 AND 256 AND "billing_invoice_resolutions"."reason" IS NULL
  ) OR (
    "billing_invoice_resolutions"."kind"='void' AND "billing_invoice_resolutions"."amount_minor" IS NULL AND "billing_invoice_resolutions"."received_date" IS NULL AND "billing_invoice_resolutions"."method" IS NULL AND "billing_invoice_resolutions"."reference" IS NULL
    AND "billing_invoice_resolutions"."reason" IS NOT NULL AND length(btrim("billing_invoice_resolutions"."reason")) BETWEEN 1 AND 500
  )),
  CONSTRAINT "invoice_resolution_review" CHECK (("billing_invoice_resolutions"."state"='needs_review') = ("billing_invoice_resolutions"."review_reason" IS NOT NULL) AND ("billing_invoice_resolutions"."review_reason" IS NULL OR "billing_invoice_resolutions"."review_reason" IN ('provider_unavailable','collection_conflict','possible_overpayment','amount_mismatch','uncertain_outcome','retry_exhausted','receipt_correction','provider_mismatch'))),
  CONSTRAINT "invoice_resolution_confirmation" CHECK (("billing_invoice_resolutions"."state"<>'confirmed' OR ("billing_invoice_resolutions"."confirmed_at" IS NOT NULL AND "billing_invoice_resolutions"."response_at" IS NOT NULL)) AND ("billing_invoice_resolutions"."confirmed_at" IS NULL OR ("billing_invoice_resolutions"."attempted_at" IS NOT NULL AND "billing_invoice_resolutions"."confirmed_at">="billing_invoice_resolutions"."attempted_at" AND "billing_invoice_resolutions"."state" IN ('confirmed','needs_review')))),
  CONSTRAINT "invoice_resolution_withdrawal" CHECK ("billing_invoice_resolutions"."state"<>'withdrawn' OR ("billing_invoice_resolutions"."kind"='external_payment' AND "billing_invoice_resolutions"."attempted_at" IS NULL AND "billing_invoice_resolutions"."confirmed_at" IS NULL)),
  CONSTRAINT "invoice_resolution_retry" CHECK ("billing_invoice_resolutions"."attempts" BETWEEN 0 AND 5 AND ("billing_invoice_resolutions"."next_attempt_at" IS NULL OR ("billing_invoice_resolutions"."state"='pending' AND "billing_invoice_resolutions"."attempts"<5 AND "billing_invoice_resolutions"."next_attempt_at">="billing_invoice_resolutions"."created_at")) AND ("billing_invoice_resolutions"."state"<>'pending' OR "billing_invoice_resolutions"."attempts"<5)),
  CONSTRAINT "invoice_resolution_baseline" CHECK ((
    "billing_invoice_resolutions"."baseline_at" IS NULL AND "billing_invoice_resolutions"."baseline_remaining_minor" IS NULL AND "billing_invoice_resolutions"."baseline_paid_off_stripe_minor" IS NULL AND "billing_invoice_resolutions"."baseline_payments" IS NULL
  ) OR (
    "billing_invoice_resolutions"."baseline_at" IS NOT NULL AND "billing_invoice_resolutions"."baseline_at">="billing_invoice_resolutions"."created_at"
    AND "billing_invoice_resolutions"."baseline_remaining_minor" IS NOT NULL AND "billing_invoice_resolutions"."baseline_remaining_minor" BETWEEN 0 AND 99999999
    AND "billing_invoice_resolutions"."baseline_paid_off_stripe_minor" IS NOT NULL AND "billing_invoice_resolutions"."baseline_paid_off_stripe_minor" BETWEEN 0 AND 99999999
    AND "billing_invoice_resolutions"."baseline_payments" IS NOT NULL AND jsonb_typeof("billing_invoice_resolutions"."baseline_payments")='array'
  )),
  CONSTRAINT "invoice_resolution_baseline_payments" CHECK ("billing_invoice_resolutions"."baseline_payments" IS NULL OR NOT jsonb_path_exists("billing_invoice_resolutions"."baseline_payments", '$[*] ? (@.type() != "object" || !(exists(@.invoicePaymentId)) || @.invoicePaymentId.type() != "string" || @.invoicePaymentId == "" || !(exists(@.paymentIntentId)) || @.paymentIntentId.type() != "string" || @.paymentIntentId == "" || !(exists(@.paidMinor)) || @.paidMinor.type() != "number" || @.paidMinor < 0 || @.paidMinor > 99999999 || @.paidMinor.floor() != @.paidMinor || !(exists(@.receivedMinor)) || @.receivedMinor.type() != "number" || @.receivedMinor < 0 || @.receivedMinor > 99999999 || @.receivedMinor.floor() != @.receivedMinor)')),
  CONSTRAINT "invoice_resolution_attempt" CHECK ("billing_invoice_resolutions"."attempted_at" IS NULL OR ("billing_invoice_resolutions"."baseline_at" IS NOT NULL AND "billing_invoice_resolutions"."attempted_at">="billing_invoice_resolutions"."baseline_at")),
  CONSTRAINT "invoice_resolution_response" CHECK (("billing_invoice_resolutions"."response_at" IS NULL AND "billing_invoice_resolutions"."response_paid_off_stripe_minor" IS NULL) OR ("billing_invoice_resolutions"."response_at" IS NOT NULL AND "billing_invoice_resolutions"."attempted_at" IS NOT NULL AND "billing_invoice_resolutions"."response_at">="billing_invoice_resolutions"."attempted_at" AND (("billing_invoice_resolutions"."kind"='void' AND "billing_invoice_resolutions"."response_paid_off_stripe_minor" IS NULL) OR ("billing_invoice_resolutions"."kind"='external_payment' AND "billing_invoice_resolutions"."response_paid_off_stripe_minor" IS NOT NULL AND "billing_invoice_resolutions"."response_paid_off_stripe_minor" BETWEEN 0 AND 99999999)))),
  CONSTRAINT "invoice_resolution_inspection" CHECK (("billing_invoice_resolutions"."last_checked_at" IS NULL AND "billing_invoice_resolutions"."last_remaining_minor" IS NULL AND "billing_invoice_resolutions"."last_collection_state" IS NULL) OR ("billing_invoice_resolutions"."last_checked_at" IS NOT NULL AND "billing_invoice_resolutions"."last_checked_at">="billing_invoice_resolutions"."created_at" AND "billing_invoice_resolutions"."last_remaining_minor" IS NOT NULL AND "billing_invoice_resolutions"."last_remaining_minor" BETWEEN 0 AND 99999999 AND "billing_invoice_resolutions"."last_collection_state" IS NOT NULL AND "billing_invoice_resolutions"."last_collection_state" IN ('idle','active','unknown')))
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "collection_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "collection_remaining_minor" integer;--> statement-breakpoint
ALTER TABLE "billing_invoice_resolutions" ADD CONSTRAINT "billing_invoice_resolutions_invoice_id_billing_customer_id_deployment_key_invoices_id_billing_customer_id_deployment_key_fk" FOREIGN KEY ("invoice_id","billing_customer_id","deployment_key") REFERENCES "public"."invoices"("id","billing_customer_id","deployment_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_invoice_resolutions" ADD CONSTRAINT "billing_invoice_resolutions_billing_customer_id_customer_id_deployment_key_billing_customers_id_customer_id_deployment_key_fk" FOREIGN KEY ("billing_customer_id","customer_id","deployment_key") REFERENCES "public"."billing_customers"("id","customer_id","deployment_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_resolution_request" ON "billing_invoice_resolutions" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_resolution_active" ON "billing_invoice_resolutions" USING btree ("invoice_id") WHERE "billing_invoice_resolutions"."state" <> 'withdrawn';--> statement-breakpoint
CREATE INDEX "invoice_resolution_pending" ON "billing_invoice_resolutions" USING btree ("deployment_key","state","next_attempt_at");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoice_collection_observation" CHECK (("invoices"."collection_checked_at" IS NULL AND "invoices"."collection_remaining_minor" IS NULL) OR ("invoices"."collection_checked_at" IS NOT NULL AND "invoices"."collection_checked_at">="invoices"."created_at" AND "invoices"."collection_remaining_minor" IS NOT NULL AND "invoices"."collection_remaining_minor" BETWEEN 0 AND 99999999));
