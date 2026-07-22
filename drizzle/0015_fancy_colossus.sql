CREATE TABLE "exam_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exam_id" uuid NOT NULL,
	"from_status" varchar(20),
	"to_status" varchar(20) NOT NULL,
	"actor_id" uuid,
	"remarks" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "exams" ADD COLUMN "quality_score" integer;--> statement-breakpoint
ALTER TABLE "exams" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "exams" ADD COLUMN "reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "exams" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "exams" ADD COLUMN "review_remarks" text;--> statement-breakpoint
ALTER TABLE "exams" ADD COLUMN "results_published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "exams" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "exam_status_history" ADD CONSTRAINT "exam_status_history_exam_id_exams_id_fk" FOREIGN KEY ("exam_id") REFERENCES "public"."exams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_status_history" ADD CONSTRAINT "exam_status_history_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exam_status_history_exam_id_idx" ON "exam_status_history" USING btree ("exam_id");--> statement-breakpoint
ALTER TABLE "exams" ADD CONSTRAINT "exams_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;