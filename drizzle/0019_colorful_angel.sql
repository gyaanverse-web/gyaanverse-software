CREATE TABLE "ocr_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_hash" varchar(64) NOT NULL,
	"source" text NOT NULL,
	"ocr_data" text NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ocr_cache_source_hash_idx" ON "ocr_cache" USING btree ("source_hash");