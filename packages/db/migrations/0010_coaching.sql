CREATE TABLE "coaching_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"task_id" uuid,
	"kind" text NOT NULL,
	"note" text NOT NULL,
	"by" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"proposal_id" uuid,
	"applied_version" integer,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coaching_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"base_version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"explanation" text DEFAULT '' NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'replaying' NOT NULL,
	"replay" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"published_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coaching_notes" ADD CONSTRAINT "coaching_notes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coaching_notes" ADD CONSTRAINT "coaching_notes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coaching_notes" ADD CONSTRAINT "coaching_notes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coaching_proposals" ADD CONSTRAINT "coaching_proposals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coaching_proposals" ADD CONSTRAINT "coaching_proposals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coaching_notes_agent" ON "coaching_notes" USING btree ("agent_id","status","created_at");--> statement-breakpoint
CREATE INDEX "coaching_notes_task" ON "coaching_notes" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "coaching_proposals_agent" ON "coaching_proposals" USING btree ("agent_id","created_at");--> statement-breakpoint
-- Coaching notes kept until now in the activity log become coaching notes, open.
INSERT INTO "coaching_notes" ("company_id", "agent_id", "task_id", "kind", "note", "by", "data", "created_at", "updated_at")
SELECT a."company_id", g."id",
  COALESCE(
    (SELECT t."id" FROM "tasks" t WHERE t."id"::text = a."data"->>'taskId'),
    (SELECT r."task_id" FROM "approvals" p JOIN "runs" r ON r."id" = p."run_id" WHERE p."id"::text = a."data"->>'approvalId')
  ),
  CASE
    WHEN a."data"->>'workItemId' IS NOT NULL THEN 'check'
    WHEN a."data"->>'edits' IS NOT NULL AND a."data"->>'edits' <> 'null' THEN 'correction'
    ELSE 'rejection'
  END,
  COALESCE(NULLIF(a."data"->>'note', ''), a."summary"), a."actor", a."data", a."created_at", a."created_at"
FROM "activity_log" a JOIN "agents" g ON g."id"::text = a."entity_id"
WHERE a."action" = 'agent.coaching_note';
