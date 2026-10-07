CREATE TABLE "conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text DEFAULT 'text' NOT NULL,
	"author" jsonb NOT NULL,
	"author_kind" text NOT NULL,
	"author_id" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"mentions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"card" jsonb,
	"card_key" text,
	"run_id" uuid,
	"reply_to_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_name" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"read_seq" integer DEFAULT 0 NOT NULL,
	"since_seq" integer DEFAULT 0 NOT NULL,
	"invited_by" jsonb,
	"expires_at" timestamp with time zone,
	"link_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"about_id" text,
	"title" text DEFAULT '' NOT NULL,
	"department_id" uuid,
	"visibility" text DEFAULT 'participants' NOT NULL,
	"created_by" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_messages_seq" ON "conversation_messages" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_messages_card" ON "conversation_messages" USING btree ("conversation_id","card_key") WHERE "conversation_messages"."card_key" is not null;--> statement-breakpoint
CREATE INDEX "conversation_messages_mentions" ON "conversation_messages" USING gin ("mentions");--> statement-breakpoint
CREATE INDEX "conversation_messages_company" ON "conversation_messages" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_participants_actor" ON "conversation_participants" USING btree ("conversation_id","actor_kind","actor_id");--> statement-breakpoint
CREATE INDEX "conversation_participants_by_actor" ON "conversation_participants" USING btree ("company_id","actor_kind","actor_id");--> statement-breakpoint
CREATE INDEX "conversations_company_last" ON "conversations" USING btree ("company_id","last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_about" ON "conversations" USING btree ("company_id","kind","about_id") WHERE "conversations"."kind" in ('task', 'thing', 'studio');