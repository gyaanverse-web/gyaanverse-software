CREATE TABLE "chapters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exam_chapters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exam_id" uuid NOT NULL,
	"chapter_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exam_classes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exam_id" uuid NOT NULL,
	"class_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exam_subjects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exam_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subjects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"grade_level" varchar(50),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "exam_access" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "exam_access" CASCADE;--> statement-breakpoint
ALTER TABLE "exams" DROP CONSTRAINT "exams_teacher_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "questions" DROP CONSTRAINT "questions_exam_id_exams_id_fk";
--> statement-breakpoint
ALTER TABLE "session_answers" DROP CONSTRAINT "session_answers_session_id_exam_sessions_id_fk";
--> statement-breakpoint
DROP INDEX "questions_tenant_id_idx";--> statement-breakpoint
DROP INDEX "exam_sessions_tenant_id_idx";--> statement-breakpoint
ALTER TABLE "exam_sessions" ALTER COLUMN "tenant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "session_answers" ALTER COLUMN "image_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "exams" ADD COLUMN "created_by" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "exams" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "exams" ADD COLUMN "instructions" text;--> statement-breakpoint
ALTER TABLE "exams" ADD COLUMN "grade_level" varchar(50);--> statement-breakpoint
ALTER TABLE "exams" ADD COLUMN "subject_id" uuid;--> statement-breakpoint
ALTER TABLE "exams" ADD COLUMN "scope_type" varchar(30) DEFAULT 'custom' NOT NULL;--> statement-breakpoint
ALTER TABLE "exams" ADD COLUMN "max_attempts" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "exams" ADD COLUMN "total_marks" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "exams" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "exams" ADD COLUMN "scheduled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "exams" ADD COLUMN "ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "type" varchar(30) NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "image_urls" text[];--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "payload" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "answer_key" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "negative_marks" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "explanation" text;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "exam_sessions" ADD COLUMN "attempt_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "exam_sessions" ADD COLUMN "expires_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "exam_sessions" ADD COLUMN "auto_score" integer;--> statement-breakpoint
ALTER TABLE "exam_sessions" ADD COLUMN "manual_score" integer;--> statement-breakpoint
ALTER TABLE "exam_sessions" ADD COLUMN "total_marks" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "session_answers" ADD COLUMN "answer" jsonb;--> statement-breakpoint
ALTER TABLE "session_answers" ADD COLUMN "is_correct" boolean;--> statement-breakpoint
ALTER TABLE "session_answers" ADD COLUMN "awarded_marks" integer;--> statement-breakpoint
ALTER TABLE "session_answers" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_chapters" ADD CONSTRAINT "exam_chapters_exam_id_exams_id_fk" FOREIGN KEY ("exam_id") REFERENCES "public"."exams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_chapters" ADD CONSTRAINT "exam_chapters_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_classes" ADD CONSTRAINT "exam_classes_exam_id_exams_id_fk" FOREIGN KEY ("exam_id") REFERENCES "public"."exams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_classes" ADD CONSTRAINT "exam_classes_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_subjects" ADD CONSTRAINT "exam_subjects_exam_id_exams_id_fk" FOREIGN KEY ("exam_id") REFERENCES "public"."exams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_subjects" ADD CONSTRAINT "exam_subjects_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chapters_subject_id_idx" ON "chapters" USING btree ("subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "exam_chapters_uniq" ON "exam_chapters" USING btree ("exam_id","chapter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "exam_classes_uniq" ON "exam_classes" USING btree ("exam_id","class_id");--> statement-breakpoint
CREATE UNIQUE INDEX "exam_subjects_uniq" ON "exam_subjects" USING btree ("exam_id","subject_id");--> statement-breakpoint
CREATE INDEX "subjects_tenant_id_idx" ON "subjects" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "exams" ADD CONSTRAINT "exams_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exams" ADD CONSTRAINT "exams_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_exam_id_exams_id_fk" FOREIGN KEY ("exam_id") REFERENCES "public"."exams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_answers" ADD CONSTRAINT "session_answers_session_id_exam_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."exam_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "questions_exam_id_idx" ON "questions" USING btree ("exam_id");--> statement-breakpoint
CREATE INDEX "exam_sessions_exam_id_idx" ON "exam_sessions" USING btree ("exam_id");--> statement-breakpoint
CREATE INDEX "exam_sessions_student_id_idx" ON "exam_sessions" USING btree ("student_id");--> statement-breakpoint
CREATE UNIQUE INDEX "exam_sessions_attempt_uniq" ON "exam_sessions" USING btree ("exam_id","student_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "session_answers_uniq" ON "session_answers" USING btree ("session_id","question_id");--> statement-breakpoint
ALTER TABLE "exams" DROP COLUMN "teacher_id";--> statement-breakpoint
ALTER TABLE "exams" DROP COLUMN "is_paid";--> statement-breakpoint
ALTER TABLE "session_answers" DROP COLUMN "uploaded_at";