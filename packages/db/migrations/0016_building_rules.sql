CREATE TABLE "build_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"item_type" text NOT NULL,
	"item_id" uuid NOT NULL,
	"department_id" uuid,
	"request" jsonb NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"requested_by" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"item_type" text NOT NULL,
	"item_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "data_tables" ADD COLUMN "approved_personal" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "data_tables" SET "approved_personal" = COALESCE((SELECT jsonb_agg(f->>'key') FROM jsonb_array_elements("fields") AS f WHERE f->>'personal' = 'true'), '[]'::jsonb);--> statement-breakpoint
ALTER TABLE "build_reviews" ADD CONSTRAINT "build_reviews_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_reviews" ADD CONSTRAINT "build_reviews_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_versions" ADD CONSTRAINT "data_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "build_reviews_company" ON "build_reviews" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "data_versions_item_version" ON "data_versions" USING btree ("item_type","item_id","version");