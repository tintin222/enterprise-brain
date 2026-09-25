CREATE TABLE "task_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"type" text NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"actor" text DEFAULT 'system' NOT NULL,
	"run_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'working' NOT NULL,
	"source" text DEFAULT 'request' NOT NULL,
	"source_ref" text,
	"requested_by" text,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"plan" jsonb,
	"waiting_for" jsonb,
	"next_check_at" timestamp with time zone,
	"outcome" text,
	"wakeups" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_events_task" ON "task_events" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_company_ref" ON "tasks" USING btree ("company_id","ref");--> statement-breakpoint
CREATE INDEX "tasks_company_status" ON "tasks" USING btree ("company_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "tasks_agent" ON "tasks" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "tasks_next_check" ON "tasks" USING btree ("status","next_check_at");--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;