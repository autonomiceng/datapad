CREATE TABLE "component_names" (
  "component_id" uuid NOT NULL,
  "customer_id" uuid NOT NULL,
  "component_kind" text NOT NULL,
  "website_id" uuid,
  "hostname" text NOT NULL,
  "is_primary" boolean NOT NULL,
  CONSTRAINT "component_names_component_id_hostname_pk" PRIMARY KEY("component_id","hostname"),
  CONSTRAINT "component_name_website" CHECK (("component_names"."component_kind" = 'web') = ("component_names"."website_id" is not null)),
  CONSTRAINT "component_name_primary" CHECK (not "component_names"."is_primary" or "component_names"."website_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "domain_registrations" (
  "service_id" uuid PRIMARY KEY NOT NULL,
  "customer_id" uuid NOT NULL,
  "service_kind" text DEFAULT 'domain_registration' NOT NULL,
  "registered_name" text NOT NULL,
  "registrar_label" text NOT NULL,
  "manager" text NOT NULL,
  "expires_on" date,
  "renewal_responsibility" text NOT NULL,
  CONSTRAINT "registration_service_kind" CHECK ("domain_registrations"."service_kind" = 'domain_registration'),
  CONSTRAINT "registration_manager" CHECK ("domain_registrations"."manager" in ('staff','customer')),
  CONSTRAINT "registration_renewal_responsibility" CHECK ("domain_registrations"."renewal_responsibility" in ('staff','customer','unknown'))
);
--> statement-breakpoint
CREATE TABLE "hosting_accounts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "customer_id" uuid NOT NULL,
  "provider_key" text NOT NULL,
  "provider_label" text NOT NULL,
  "label" text NOT NULL,
  CONSTRAINT "hosting_account_customer" UNIQUE("id","customer_id")
);
--> statement-breakpoint
CREATE TABLE "service_components" (
  "id" uuid PRIMARY KEY NOT NULL,
  "customer_id" uuid NOT NULL,
  "service_id" uuid NOT NULL,
  "service_kind" text DEFAULT 'hosting' NOT NULL,
  "kind" text NOT NULL,
  "delivery" text NOT NULL,
  "provider_label" text NOT NULL,
  "hosting_account_id" uuid,
  "manager" text NOT NULL,
  "requested_setting" text,
  "provider_state" text NOT NULL,
  "checked_at" timestamp with time zone,
  "version" integer DEFAULT 1 NOT NULL,
  CONSTRAINT "service_component_customer_kind" UNIQUE("id","customer_id","kind"),
  CONSTRAINT "component_hosting_service" CHECK ("service_components"."service_kind" = 'hosting'),
  CONSTRAINT "component_kind" CHECK ("service_components"."kind" in ('web','email','dns')),
  CONSTRAINT "component_delivery" CHECK ("service_components"."delivery" in ('hosted','external') and ("service_components"."delivery" = 'external' or "service_components"."hosting_account_id" is not null)),
  CONSTRAINT "component_manager" CHECK ("service_components"."manager" in ('staff','customer')),
  CONSTRAINT "component_requested_setting" CHECK (("service_components"."delivery" = 'external' and "service_components"."manager" = 'customer' and "service_components"."requested_setting" is null) or (not ("service_components"."delivery" = 'external' and "service_components"."manager" = 'customer') and "service_components"."requested_setting" is not null and "service_components"."requested_setting" in ('enabled','disabled'))),
  CONSTRAINT "component_provider_state" CHECK (("service_components"."provider_state" = 'unknown' and "service_components"."checked_at" is null) or ("service_components"."provider_state" in ('enabled','disabled') and "service_components"."checked_at" is not null)),
  CONSTRAINT "component_version" CHECK ("service_components"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "services" (
  "id" uuid PRIMARY KEY NOT NULL,
  "customer_id" uuid NOT NULL,
  "source_key" text NOT NULL,
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "package_name" text,
  "included_components" text[] NOT NULL,
  "attached_service_id" uuid,
  "attached_service_kind" text,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "service_customer_kind" UNIQUE("id","customer_id","kind"),
  CONSTRAINT "service_source_key" UNIQUE("customer_id","source_key"),
  CONSTRAINT "service_kind" CHECK ("services"."kind" in ('hosting','addon','domain_registration')),
  CONSTRAINT "service_attachment_pair" CHECK (("services"."attached_service_id" is null and "services"."attached_service_kind" is null) or ("services"."attached_service_id" is not null and "services"."attached_service_kind" in ('hosting','domain_registration') and "services"."attached_service_kind" is not null)),
  CONSTRAINT "service_attachment_addon" CHECK ("services"."kind" = 'addon' or ("services"."attached_service_id" is null and "services"."attached_service_kind" is null)),
  CONSTRAINT "service_version" CHECK ("services"."version" > 0),
  CONSTRAINT "service_name" CHECK (length(trim("services"."name")) between 1 and 256),
  CONSTRAINT "service_components" CHECK ("services"."included_components" <@ array['web','email','dns']::text[] and cardinality("services"."included_components") <= 3 and ("services"."kind" = 'hosting' or cardinality("services"."included_components") = 0))
);
--> statement-breakpoint
CREATE TABLE "websites" (
  "id" uuid PRIMARY KEY NOT NULL,
  "customer_id" uuid NOT NULL,
  "component_id" uuid NOT NULL,
  "component_kind" text DEFAULT 'web' NOT NULL,
  CONSTRAINT "website_component_customer" UNIQUE("id","component_id","customer_id"),
  CONSTRAINT "website_web_kind" CHECK ("websites"."component_kind" = 'web')
);
--> statement-breakpoint
ALTER TABLE "component_names" ADD CONSTRAINT "name_component_customer_kind" FOREIGN KEY ("component_id","customer_id","component_kind") REFERENCES "public"."service_components"("id","customer_id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_names" ADD CONSTRAINT "name_website_customer_component" FOREIGN KEY ("website_id","component_id","customer_id") REFERENCES "public"."websites"("id","component_id","customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_registrations" ADD CONSTRAINT "registration_service_customer" FOREIGN KEY ("service_id","customer_id","service_kind") REFERENCES "public"."services"("id","customer_id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_accounts" ADD CONSTRAINT "hosting_accounts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_components" ADD CONSTRAINT "component_service_customer" FOREIGN KEY ("service_id","customer_id","service_kind") REFERENCES "public"."services"("id","customer_id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_components" ADD CONSTRAINT "component_hosting_customer" FOREIGN KEY ("hosting_account_id","customer_id") REFERENCES "public"."hosting_accounts"("id","customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "service_attachment_customer_kind" FOREIGN KEY ("attached_service_id","customer_id","attached_service_kind") REFERENCES "public"."services"("id","customer_id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "websites" ADD CONSTRAINT "website_web_component" FOREIGN KEY ("component_id","customer_id","component_kind") REFERENCES "public"."service_components"("id","customer_id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "website_one_primary" ON "component_names" USING btree ("website_id") WHERE "component_names"."is_primary";
