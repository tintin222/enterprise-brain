CREATE TABLE "data_record_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"action" text NOT NULL,
	"changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"by" text NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "data_tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"department_id" uuid,
	"fields" jsonb NOT NULL,
	"title_field" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "data_record_changes" ADD CONSTRAINT "data_record_changes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_record_changes" ADD CONSTRAINT "data_record_changes_table_id_data_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."data_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_record_changes" ADD CONSTRAINT "data_record_changes_record_id_data_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."data_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_records" ADD CONSTRAINT "data_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_records" ADD CONSTRAINT "data_records_table_id_data_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."data_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_tables" ADD CONSTRAINT "data_tables_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_tables" ADD CONSTRAINT "data_tables_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_record_changes_record" ON "data_record_changes" USING btree ("record_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "data_records_table_number" ON "data_records" USING btree ("table_id","number");--> statement-breakpoint
CREATE INDEX "data_records_table_created" ON "data_records" USING btree ("table_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "data_tables_company_key" ON "data_tables" USING btree ("company_id","key");