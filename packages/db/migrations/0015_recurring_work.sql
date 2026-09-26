CREATE TABLE "recurring_work" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"text" text NOT NULL,
	"schedule" jsonb NOT NULL,
	"user_id" uuid,
	"by" text NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	"stopped_by" text
);
--> statement-breakpoint
ALTER TABLE "recurring_work" ADD CONSTRAINT "recurring_work_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_work" ADD CONSTRAINT "recurring_work_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_work" ADD CONSTRAINT "recurring_work_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recurring_work_company" ON "recurring_work" USING btree ("company_id","agent_id");