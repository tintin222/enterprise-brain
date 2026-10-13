-- Procedures in a job (steps holding steps, loops, callbacks) and what runs show and accept: one row per step attempt
-- with its input and output (run_steps), the address a run waiting for another system is called back on
-- (run_callbacks), each AI employee's webhook address and public form (agent_endpoints), and per-AI-employee
-- settings that are not part of its versioned job (agents.settings). Indexes for the executions list.
CREATE TABLE "agent_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"token" text NOT NULL,
	"secret_ciphertext" text,
	"status" text DEFAULT 'on' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"uses" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_callbacks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"last_called_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"key" text NOT NULL,
	"step_id" text NOT NULL,
	"type" text NOT NULL,
	"iteration" integer,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"input_truncated" boolean DEFAULT false NOT NULL,
	"output_truncated" boolean DEFAULT false NOT NULL,
	"error" text,
	"usage" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_endpoints" ADD CONSTRAINT "agent_endpoints_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_endpoints" ADD CONSTRAINT "agent_endpoints_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_callbacks" ADD CONSTRAINT "run_callbacks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_callbacks" ADD CONSTRAINT "run_callbacks_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_endpoints_token" ON "agent_endpoints" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_endpoints_agent_kind" ON "agent_endpoints" USING btree ("agent_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "run_callbacks_token" ON "run_callbacks" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "run_callbacks_run" ON "run_callbacks" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_steps_run_key_attempt" ON "run_steps" USING btree ("run_id","key","attempt");--> statement-breakpoint
CREATE INDEX "run_steps_run" ON "run_steps" USING btree ("run_id","started_at");--> statement-breakpoint
CREATE INDEX "runs_company_status" ON "runs" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "runs_agent_created" ON "runs" USING btree ("agent_id","created_at");