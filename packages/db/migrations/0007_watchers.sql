CREATE TABLE "watch_cursors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connector_instance_id" uuid NOT NULL,
	"key" text NOT NULL,
	"cursor" text,
	"last_polled_at" timestamp with time zone,
	"last_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "watch_cursors" ADD CONSTRAINT "watch_cursors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_cursors" ADD CONSTRAINT "watch_cursors_connector_instance_id_connector_instances_id_fk" FOREIGN KEY ("connector_instance_id") REFERENCES "public"."connector_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "watch_cursors_instance_key" ON "watch_cursors" USING btree ("connector_instance_id","key");--> statement-breakpoint
CREATE INDEX "mail_messages_external" ON "mail_messages" USING btree ("company_id","external_id");