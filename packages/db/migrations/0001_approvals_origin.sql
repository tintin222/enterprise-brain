ALTER TABLE "approvals" ALTER COLUMN "run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "origin" text DEFAULT 'workflow' NOT NULL;