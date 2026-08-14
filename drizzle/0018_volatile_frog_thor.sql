ALTER TABLE "evaluation_jobs" ADD COLUMN "last_error_code" varchar(50);--> statement-breakpoint
ALTER TABLE "evaluation_jobs" ADD COLUMN "failure_class" varchar(20);--> statement-breakpoint
ALTER TABLE "evaluation_jobs" ADD COLUMN "next_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "evaluation_jobs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "evaluation_jobs_sweep_idx" ON "evaluation_jobs" USING btree ("status","next_retry_at");--> statement-breakpoint
CREATE INDEX "evaluation_jobs_lease_idx" ON "evaluation_jobs" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "question_results_job_id_question_id_idx" ON "question_results" USING btree ("job_id","question_id");