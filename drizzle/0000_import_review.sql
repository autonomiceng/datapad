CREATE TABLE "import_customers" (
  "import_id" uuid NOT NULL,
  "source_record_id" text NOT NULL,
  "observation" jsonb NOT NULL,
  "known_status" boolean NOT NULL,
  CONSTRAINT "import_customers_import_id_source_record_id_pk" PRIMARY KEY("import_id","source_record_id")
);
--> statement-breakpoint
CREATE TABLE "import_domains" (
  "import_id" uuid NOT NULL,
  "source_record_id" text NOT NULL,
  "customer_id" text NOT NULL,
  "observation" jsonb NOT NULL,
  "known_status" boolean NOT NULL,
  "due_date" date,
  "next_invoice_date" date,
  "expiry_date" date,
  CONSTRAINT "import_domains_import_id_source_record_id_pk" PRIMARY KEY("import_id","source_record_id")
);
--> statement-breakpoint
CREATE TABLE "imports" (
  "id" uuid PRIMARY KEY NOT NULL,
  "schema_version" integer NOT NULL,
  "source_id" text NOT NULL,
  "source_reference" text NOT NULL,
  "data_as_of" timestamp with time zone NOT NULL,
  "digest" text NOT NULL,
  "record_counts" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_services" (
  "import_id" uuid NOT NULL,
  "record_type" text NOT NULL,
  "source_record_id" text NOT NULL,
  "customer_id" text NOT NULL,
  "attached_service_id" text,
  "observation" jsonb NOT NULL,
  "known_status" boolean NOT NULL,
  "due_date" date,
  "next_invoice_date" date,
  CONSTRAINT "import_services_import_id_record_type_source_record_id_pk" PRIMARY KEY("import_id","record_type","source_record_id")
);
--> statement-breakpoint
ALTER TABLE "import_customers" ADD CONSTRAINT "import_customers_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_domains" ADD CONSTRAINT "import_domains_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_services" ADD CONSTRAINT "import_services_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_domains_customer" ON "import_domains" USING btree ("import_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "import_identity" ON "imports" USING btree ("source_id","source_reference");--> statement-breakpoint
CREATE INDEX "import_services_customer" ON "import_services" USING btree ("import_id","customer_id");
