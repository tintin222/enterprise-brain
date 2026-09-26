CREATE TABLE "data_calculation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"calculation_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"result" jsonb,
	"error" text,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"rows" integer DEFAULT 0 NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_calculations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"rule" text NOT NULL,
	"explanation" text DEFAULT '' NOT NULL,
	"department_id" uuid,
	"tables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"code" text NOT NULL,
	"output" jsonb NOT NULL,
	"schedule" text,
	"version" integer DEFAULT 1 NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "data_calculation_runs" ADD CONSTRAINT "data_calculation_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_calculation_runs" ADD CONSTRAINT "data_calculation_runs_calculation_id_data_calculations_id_fk" FOREIGN KEY ("calculation_id") REFERENCES "public"."data_calculations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_calculations" ADD CONSTRAINT "data_calculations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_calculations" ADD CONSTRAINT "data_calculations_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_calculation_runs_calculation" ON "data_calculation_runs" USING btree ("calculation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "data_calculations_company_key" ON "data_calculations" USING btree ("company_id","key");