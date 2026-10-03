ALTER TABLE "invoices" DROP CONSTRAINT "invoice_review_reason";--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "provider_receipt_state" text DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoice_provider_receipt_state" CHECK ("invoices"."provider_receipt_state" IN ('unverified', 'verified', 'mismatch'));--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoice_review_reason" CHECK (("invoices"."state" = 'needs_review' OR "invoices"."provider_receipt_state" = 'mismatch') = ("invoices"."review_reason" IS NOT NULL));
