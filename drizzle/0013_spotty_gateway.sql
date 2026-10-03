CREATE TABLE "billing_effect_controls" (
  "deployment_key" text PRIMARY KEY NOT NULL,
  "paused" boolean DEFAULT true NOT NULL,
  "version" integer NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "updated_by" text NOT NULL,
  CONSTRAINT "billing_effect_control_version" CHECK ("billing_effect_controls"."version" > 0)
);
