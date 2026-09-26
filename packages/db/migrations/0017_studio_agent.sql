CREATE TABLE "studio_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"owner" jsonb NOT NULL,
	"owner_id" text,
	"department_id" uuid,
	"status" text DEFAULT 'idle' NOT NULL,
	"setup" json NOT NULL,
	"messages" json DEFAULT '[]'::json NOT NULL,
	"pending" json,
	"solution" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"built_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "studio_events" ADD CONSTRAINT "studio_events_thread_id_studio_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."studio_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_threads" ADD CONSTRAINT "studio_threads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_threads" ADD CONSTRAINT "studio_threads_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "studio_events_thread_seq" ON "studio_events" USING btree ("thread_id","seq");--> statement-breakpoint
CREATE INDEX "studio_threads_company" ON "studio_threads" USING btree ("company_id","updated_at");