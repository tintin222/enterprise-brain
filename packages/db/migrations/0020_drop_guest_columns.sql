-- Guests were never built: nobody was held back, taken out or invited as a guest. Should such a row exist,
-- it leaves now rather than becoming a full participant once the status column is gone.
DELETE FROM "conversation_participants" WHERE "status" <> 'active' OR "actor_kind" = 'guest';--> statement-breakpoint
ALTER TABLE "conversation_participants" DROP COLUMN "since_seq";--> statement-breakpoint
ALTER TABLE "conversation_participants" DROP COLUMN "expires_at";--> statement-breakpoint
ALTER TABLE "conversation_participants" DROP COLUMN "link_version";--> statement-breakpoint
ALTER TABLE "conversation_participants" DROP COLUMN "status";