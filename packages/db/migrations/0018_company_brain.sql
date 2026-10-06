CREATE TABLE "brain_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"origins" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"search_text" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text DEFAULT 'system' NOT NULL,
	"updated_by" text DEFAULT 'system' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brain_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"origin" text NOT NULL,
	"ref" text,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"actor" text,
	"actor_id" uuid,
	"place" text,
	"about" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brain_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"from_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"to_id" uuid NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"created_by" text DEFAULT 'system' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brain_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"syncs" integer DEFAULT 0 NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brain_entities" ADD CONSTRAINT "brain_entities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_events" ADD CONSTRAINT "brain_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_events" ADD CONSTRAINT "brain_events_actor_id_brain_entities_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."brain_entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_links" ADD CONSTRAINT "brain_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_links" ADD CONSTRAINT "brain_links_from_id_brain_entities_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."brain_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_links" ADD CONSTRAINT "brain_links_to_id_brain_entities_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."brain_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_sources" ADD CONSTRAINT "brain_sources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brain_entities_company_kind_key" ON "brain_entities" USING btree ("company_id","kind","key");--> statement-breakpoint
CREATE INDEX "brain_entities_company_kind" ON "brain_entities" USING btree ("company_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "brain_events_ref" ON "brain_events" USING btree ("company_id","origin","ref");--> statement-breakpoint
CREATE INDEX "brain_events_company_at" ON "brain_events" USING btree ("company_id","at");--> statement-breakpoint
CREATE INDEX "brain_events_about" ON "brain_events" USING gin ("about");--> statement-breakpoint
CREATE UNIQUE INDEX "brain_links_unique" ON "brain_links" USING btree ("from_id","relation","to_id");--> statement-breakpoint
CREATE INDEX "brain_links_company" ON "brain_links" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "brain_links_to" ON "brain_links" USING btree ("to_id");--> statement-breakpoint
CREATE UNIQUE INDEX "brain_sources_company_key" ON "brain_sources" USING btree ("company_id","key");