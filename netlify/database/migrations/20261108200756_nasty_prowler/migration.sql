CREATE TABLE "crawl_run" (
	"id" serial PRIMARY KEY,
	"portal" text NOT NULL,
	"runner" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"pages" integer DEFAULT 0 NOT NULL,
	"fetched" integer DEFAULT 0 NOT NULL,
	"new_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "criteria" (
	"id" serial PRIMARY KEY,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"offer_type" text NOT NULL,
	"city" text NOT NULL,
	"localities" text[] DEFAULT '{}'::text[] NOT NULL,
	"price_min" integer,
	"price_max" integer,
	"layouts" text[] DEFAULT '{}'::text[] NOT NULL,
	"area_min" double precision,
	"area_max" double precision,
	"must" jsonb DEFAULT '{}' NOT NULL,
	"weights" jsonb NOT NULL,
	"anchor_lat" double precision,
	"anchor_lng" double precision,
	"max_distance_km" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listing" (
	"id" serial PRIMARY KEY,
	"portal" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"offer_type" text NOT NULL,
	"price_czk" integer,
	"fees_czk" integer,
	"area_m2" double precision,
	"layout" text,
	"floor" integer,
	"condition" text DEFAULT 'unknown' NOT NULL,
	"has_balcony" boolean,
	"has_parking" boolean,
	"has_elevator" boolean,
	"lat" double precision,
	"lng" double precision,
	"locality_text" text,
	"city" text,
	"district" text,
	"images" jsonb DEFAULT '[]' NOT NULL,
	"raw" jsonb,
	"fingerprint" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "listing_state" (
	"listing_id" integer PRIMARY KEY,
	"status" text DEFAULT 'new' NOT NULL,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_attempt" (
	"id" serial PRIMARY KEY,
	"key" text NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match" (
	"criteria_id" integer,
	"listing_id" integer,
	"score" double precision NOT NULL,
	"breakdown" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_pkey" PRIMARY KEY("criteria_id","listing_id")
);
--> statement-breakpoint
CREATE TABLE "price_history" (
	"id" serial PRIMARY KEY,
	"listing_id" integer NOT NULL,
	"price_czk" integer NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "crawl_run_portal_started_idx" ON "crawl_run" ("portal","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "listing_portal_external_id_uq" ON "listing" ("portal","external_id");--> statement-breakpoint
CREATE INDEX "listing_fingerprint_idx" ON "listing" ("fingerprint");--> statement-breakpoint
CREATE INDEX "listing_offer_city_idx" ON "listing" ("offer_type","city");--> statement-breakpoint
CREATE INDEX "login_attempt_key_attempted_idx" ON "login_attempt" ("key","attempted_at");--> statement-breakpoint
CREATE INDEX "match_criteria_score_idx" ON "match" ("criteria_id","score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "match_listing_idx" ON "match" ("listing_id");--> statement-breakpoint
CREATE INDEX "price_history_listing_observed_idx" ON "price_history" ("listing_id","observed_at");--> statement-breakpoint
ALTER TABLE "listing_state" ADD CONSTRAINT "listing_state_listing_id_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listing"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "match" ADD CONSTRAINT "match_criteria_id_criteria_id_fkey" FOREIGN KEY ("criteria_id") REFERENCES "criteria"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "match" ADD CONSTRAINT "match_listing_id_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listing"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_listing_id_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listing"("id") ON DELETE CASCADE;