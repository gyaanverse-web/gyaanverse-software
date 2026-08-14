ALTER TABLE "evaluation_jobs" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "question_results" ADD COLUMN "review_status" varchar(20) DEFAULT 'ai' NOT NULL;--> statement-breakpoint
ALTER TABLE "question_results" ADD COLUMN "ai_score" integer;--> statement-breakpoint
ALTER TABLE "question_results" ADD COLUMN "reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "question_results" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "question_results" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "question_results" ADD CONSTRAINT "question_results_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "question_results_review_status_idx" ON "question_results" USING btree ("review_status");