ALTER TABLE "report_items" DROP CONSTRAINT "report_items_report_id_reports_id_fk";
--> statement-breakpoint
ALTER TABLE "report_items" ALTER COLUMN "image_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ALTER COLUMN "status" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "auto_score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "ai_score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "report_items" ADD CONSTRAINT "report_items_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "report_items_report_question_uniq" ON "report_items" USING btree ("report_id","question_id");--> statement-breakpoint
CREATE INDEX "reports_exam_id_idx" ON "reports" USING btree ("exam_id");--> statement-breakpoint
CREATE INDEX "reports_student_id_idx" ON "reports" USING btree ("student_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_session_uniq" ON "reports" USING btree ("session_id");