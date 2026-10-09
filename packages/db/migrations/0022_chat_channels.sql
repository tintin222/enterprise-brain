-- Chat becomes Slack-like: channels (named; #general and one per department are built in), direct messages (one
-- per set of people, by dm_key), threads (a conversation under a parent, about its root message) and emoji
-- reactions. Existing topics become channels or direct messages when the app starts (adoptTopics).
CREATE TABLE "conversation_reactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"actor" jsonb NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "conversations_about";--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "dm_key" text;--> statement-breakpoint
ALTER TABLE "conversation_reactions" ADD CONSTRAINT "conversation_reactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_reactions" ADD CONSTRAINT "conversation_reactions_message_id_conversation_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_reactions_once" ON "conversation_reactions" USING btree ("message_id","actor_kind","actor_id","emoji");--> statement-breakpoint
CREATE INDEX "conversation_reactions_message" ON "conversation_reactions" USING btree ("message_id");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_parent_id_conversations_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_parent" ON "conversations" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_channel_name" ON "conversations" USING btree ("company_id","name") WHERE "conversations"."kind" = 'channel' and "conversations"."name" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_dm_key" ON "conversations" USING btree ("company_id","dm_key") WHERE "conversations"."dm_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_about" ON "conversations" USING btree ("company_id","kind","about_id") WHERE "conversations"."kind" in ('task', 'thing', 'studio', 'thread', 'channel');