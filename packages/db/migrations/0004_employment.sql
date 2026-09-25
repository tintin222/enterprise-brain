ALTER TABLE "agents" ADD COLUMN "manager_user_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "probation" text DEFAULT 'supervised' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "limits" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "monthly_budget_usd" double precision;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_manager_user_id_users_id_fk" FOREIGN KEY ("manager_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Agents that needed no approvals before probation levels existed keep working alone: Trusted, no limits.
UPDATE "agents" SET "probation" = 'trusted' WHERE jsonb_typeof("definition"->'guardrails'->'approvalRequiredFor') = 'array' AND jsonb_array_length("definition"->'guardrails'->'approvalRequiredFor') = 0;
