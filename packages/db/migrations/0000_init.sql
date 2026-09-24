CREATE TABLE "activity_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"summary" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"note" text,
	"created_by" text DEFAULT 'system' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"department_id" uuid,
	"process_id" uuid,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"archetype" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"template_id" text,
	"builder_session_id" uuid,
	"definition" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"paperclip_agent_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"step_id" text NOT NULL,
	"title" text NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"action" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"assignee_role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "builder_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"round" integer,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "builder_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'interviewing' NOT NULL,
	"requester_name" text,
	"requester_email" text,
	"requester_role" text,
	"department" text,
	"description" text DEFAULT '' NOT NULL,
	"archetype" text,
	"template_id" text,
	"language" text DEFAULT 'en' NOT NULL,
	"tree" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rounds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"samples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"draft" jsonb,
	"summary" text,
	"agent_id" uuid,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"title" text DEFAULT 'New conversation' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "connector_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets_ciphertext" text,
	"status" text DEFAULT 'unverified' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"template_id" text,
	"name" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"icon" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"source" text DEFAULT 'upload' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"collection_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1024),
	"embedding_model" text,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"department_id" uuid,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"collection_id" uuid NOT NULL,
	"file_id" uuid,
	"title" text NOT NULL,
	"source" text DEFAULT 'upload' NOT NULL,
	"uri" text,
	"mime_type" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"content_hash" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"mailbox" text NOT NULL,
	"direction" text DEFAULT 'inbound' NOT NULL,
	"external_id" text,
	"thread_id" text,
	"from_address" text NOT NULL,
	"from_name" text,
	"to_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"body_text" text DEFAULT '' NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"classification" jsonb,
	"run_id" uuid,
	"in_reply_to" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"department_id" uuid,
	"key" text NOT NULL,
	"template_id" text,
	"name" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"step_id" text,
	"message" text DEFAULT '' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"agent_version" integer DEFAULT 1 NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"trigger_ref" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"current_step" text,
	"error" text,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"system" text NOT NULL,
	"entity" text NOT NULL,
	"external_id" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stakeholder_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"role" text NOT NULL,
	"recipient_name" text,
	"recipient_email" text,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"questionnaire" text NOT NULL,
	"questions" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"token" text NOT NULL,
	"sent_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"answered_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stakeholder_requests_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_process_id_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."processes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_messages" ADD CONSTRAINT "builder_messages_session_id_builder_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."builder_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_sessions" ADD CONSTRAINT "builder_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_sessions" ADD CONSTRAINT "builder_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_conversation_id_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_instances" ADD CONSTRAINT "connector_instances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_collection_id_knowledge_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."knowledge_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_collections" ADD CONSTRAINT "knowledge_collections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_collections" ADD CONSTRAINT "knowledge_collections_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_collection_id_knowledge_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."knowledge_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processes" ADD CONSTRAINT "processes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processes" ADD CONSTRAINT "processes_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_records" ADD CONSTRAINT "sandbox_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stakeholder_requests" ADD CONSTRAINT "stakeholder_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stakeholder_requests" ADD CONSTRAINT "stakeholder_requests_session_id_builder_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."builder_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_log_company_created" ON "activity_log" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_versions_agent_version" ON "agent_versions" USING btree ("agent_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_company_slug" ON "agents" USING btree ("company_id","slug");--> statement-breakpoint
CREATE INDEX "approvals_company_status" ON "approvals" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "builder_messages_session" ON "builder_messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "builder_sessions_company" ON "builder_sessions" USING btree ("company_id","updated_at");--> statement-breakpoint
CREATE INDEX "chat_conversations_company" ON "chat_conversations" USING btree ("company_id","updated_at");--> statement-breakpoint
CREATE INDEX "chat_messages_conversation" ON "chat_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "connector_instances_company" ON "connector_instances" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "departments_company_key" ON "departments" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX "files_company" ON "files" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_document" ON "knowledge_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_collection" ON "knowledge_chunks" USING btree ("collection_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_tsv" ON "knowledge_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_collections_company_key" ON "knowledge_collections" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX "knowledge_documents_collection" ON "knowledge_documents" USING btree ("collection_id");--> statement-breakpoint
CREATE INDEX "mail_messages_company_mailbox" ON "mail_messages" USING btree ("company_id","mailbox","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "processes_company_key" ON "processes" USING btree ("company_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "run_events_run_seq" ON "run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "runs_company_created" ON "runs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_agent" ON "runs" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_records_key" ON "sandbox_records" USING btree ("company_id","system","entity","external_id");--> statement-breakpoint
CREATE INDEX "stakeholder_requests_session" ON "stakeholder_requests" USING btree ("session_id");