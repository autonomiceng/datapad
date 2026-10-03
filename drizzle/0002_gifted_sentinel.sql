CREATE TABLE "access_commands" (
  "request_id" uuid PRIMARY KEY NOT NULL,
  "actor_id" text NOT NULL,
  "customer_id" uuid NOT NULL,
  "action" text NOT NULL,
  "input_hash" text NOT NULL,
  "invitation_id" text,
  "target_id" text NOT NULL,
  "state" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "access_command_action" CHECK ("access_commands"."action" in ('invitation.create','invitation.accept','invitation.revoke','member.revoke')),
  CONSTRAINT "access_command_state" CHECK ("access_commands"."state" in ('pending','completed','needs_review'))
);
--> statement-breakpoint
CREATE TABLE "access_audit" (
  "id" uuid PRIMARY KEY NOT NULL,
  "request_id" uuid,
  "actor_id" text NOT NULL,
  "session_id" text,
  "customer_id" uuid,
  "action" text NOT NULL,
  "target_id" text NOT NULL,
  "details" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access_staff_grants" (
  "user_id" text NOT NULL,
  "role" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "access_staff_grants_user_id_role_pk" PRIMARY KEY("user_id","role"),
  CONSTRAINT "access_staff_role" CHECK ("access_staff_grants"."role" in ('account_administrator','billing','support'))
);
--> statement-breakpoint
CREATE TABLE "account" (
  "id" text PRIMARY KEY NOT NULL,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "user_id" text NOT NULL,
  "access_token" text,
  "refresh_token" text,
  "id_token" text,
  "access_token_expires_at" timestamp with time zone,
  "refresh_token_expires_at" timestamp with time zone,
  "scope" text,
  "password" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "email" text NOT NULL,
  "role" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "user_id" text NOT NULL,
  "role" text DEFAULT 'member' NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "member_organization_user_unique" UNIQUE("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organization" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "logo" text,
  "created_at" timestamp with time zone NOT NULL,
  "metadata" text,
  CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "session" (
  "id" text PRIMARY KEY NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "token" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "user_id" text NOT NULL,
  "active_organization_id" text,
  CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "email_verified" boolean DEFAULT false NOT NULL,
  "image" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
  "id" uuid PRIMARY KEY NOT NULL,
  "registry_key" text NOT NULL,
  "organization_id" text,
  "display_name" text NOT NULL,
  "legal_name" text NOT NULL,
  "billing_email" text,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "customers_registry_key_unique" UNIQUE("registry_key"),
  CONSTRAINT "customers_organization_id_unique" UNIQUE("organization_id"),
  CONSTRAINT "customer_version" CHECK ("customers"."version" > 0),
  CONSTRAINT "customer_names" CHECK (length(trim("customers"."display_name")) between 1 and 256 and length(trim("customers"."legal_name")) between 1 and 256)
);
--> statement-breakpoint
ALTER TABLE "billing_customers" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "bill_to_name" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "bill_to_email" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "bill_to_profile_version" integer;--> statement-breakpoint
-- Preserve provider mappings and invoice history while assigning independent customer identities.
INSERT INTO "customers" ("id", "registry_key", "display_name", "legal_name", "created_at", "updated_at")
SELECT gen_random_uuid(), '[' || to_json("deployment_key")::text || ',' || to_json("key")::text || ']', "name", "name", "created_at", "created_at"
FROM "billing_customers";
--> statement-breakpoint
UPDATE "billing_customers" AS mapping SET "customer_id" = customer."id"
FROM "customers" AS customer
WHERE customer."registry_key" = '[' || to_json(mapping."deployment_key")::text || ',' || to_json(mapping."key")::text || ']';
--> statement-breakpoint
UPDATE "invoices" AS invoice SET "bill_to_name" = mapping."name", "bill_to_profile_version" = 1
FROM "billing_customers" AS mapping WHERE invoice."customer_id" = mapping."id";
--> statement-breakpoint
ALTER TABLE "billing_customers" ALTER COLUMN "customer_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "bill_to_name" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "bill_to_profile_version" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "access_staff_grants" ADD CONSTRAINT "access_staff_grants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON "invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "member" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
ALTER TABLE "billing_customers" ADD CONSTRAINT "billing_customers_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_customer_operational_scope" ON "billing_customers" USING btree ("deployment_key","customer_id");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoice_bill_to_version" CHECK ("invoices"."bill_to_profile_version" > 0);
--> statement-breakpoint
ALTER TABLE "invoices" RENAME COLUMN "customer_id" TO "billing_customer_id";
--> statement-breakpoint
ALTER TABLE "invoices" RENAME CONSTRAINT "invoices_customer_id_deployment_key_billing_customers_id_deployment_key_fk" TO "invoices_billing_customer_id_deployment_key_billing_customers_id_deployment_key_fk";
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "request_customer_name" text;
--> statement-breakpoint
UPDATE "invoices" AS invoice SET "request_customer_name" = mapping."name"
FROM "billing_customers" AS mapping WHERE invoice."billing_customer_id" = mapping."id";
--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "request_customer_name" SET NOT NULL;
