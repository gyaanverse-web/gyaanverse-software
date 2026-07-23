CREATE TABLE "concepts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"section_id" uuid NOT NULL,
	"tenant_id" uuid,
	"name" varchar(255) NOT NULL,
	"description" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "modules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_id" uuid NOT NULL,
	"tenant_id" uuid,
	"name" varchar(255) NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_bank" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"subject_id" uuid NOT NULL,
	"module_id" uuid,
	"chapter_id" uuid,
	"section_id" uuid,
	"concept_id" uuid,
	"type" varchar(30) NOT NULL,
	"difficulty" varchar(10) NOT NULL,
	"body" text NOT NULL,
	"image_urls" text[],
	"payload" jsonb NOT NULL,
	"answer_key" jsonb NOT NULL,
	"default_marks" integer DEFAULT 1 NOT NULL,
	"default_negative_marks" integer DEFAULT 0 NOT NULL,
	"explanation" text,
	"explanation_image_urls" text[],
	"solution_video_url" text,
	"tags" text[],
	"language" varchar(10) DEFAULT 'en' NOT NULL,
	"source" jsonb,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"avg_success_rate" numeric(5, 4),
	"is_verified" boolean DEFAULT false NOT NULL,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"flag_reason" text,
	"metadata" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chapter_id" uuid NOT NULL,
	"tenant_id" uuid,
	"name" varchar(255) NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chapters" DROP CONSTRAINT "chapters_subject_id_subjects_id_fk";
--> statement-breakpoint
DROP INDEX "chapters_subject_id_idx";--> statement-breakpoint
ALTER TABLE "chapters" ALTER COLUMN "tenant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "subjects" ALTER COLUMN "tenant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chapters" ADD COLUMN "module_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "chapters" ADD COLUMN "status" varchar(20) DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "chapters" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "chapters" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "exams" ADD COLUMN "estimated_duration_mins" integer;--> statement-breakpoint
ALTER TABLE "exams" ADD COLUMN "generation_params" jsonb;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "bank_question_id" uuid;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "difficulty" varchar(10);--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "draft_status" varchar(20);--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "subjects" ADD COLUMN "code" varchar(50);--> statement-breakpoint
ALTER TABLE "subjects" ADD COLUMN "language" varchar(10) DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "subjects" ADD COLUMN "status" varchar(20) DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "subjects" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "subjects" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_section_id_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modules" ADD CONSTRAINT "modules_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modules" ADD CONSTRAINT "modules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modules" ADD CONSTRAINT "modules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_section_id_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_concept_id_concepts_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concepts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "concepts_section_id_idx" ON "concepts" USING btree ("section_id");--> statement-breakpoint
CREATE INDEX "concepts_tenant_id_idx" ON "concepts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "modules_subject_id_idx" ON "modules" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "modules_tenant_id_idx" ON "modules" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "question_bank_tenant_id_idx" ON "question_bank" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "question_bank_subject_id_idx" ON "question_bank" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "question_bank_module_id_idx" ON "question_bank" USING btree ("module_id");--> statement-breakpoint
CREATE INDEX "question_bank_chapter_id_idx" ON "question_bank" USING btree ("chapter_id");--> statement-breakpoint
CREATE INDEX "question_bank_section_id_idx" ON "question_bank" USING btree ("section_id");--> statement-breakpoint
CREATE INDEX "question_bank_concept_id_idx" ON "question_bank" USING btree ("concept_id");--> statement-breakpoint
CREATE INDEX "question_bank_gen_idx" ON "question_bank" USING btree ("status","type","difficulty");--> statement-breakpoint
CREATE INDEX "sections_chapter_id_idx" ON "sections" USING btree ("chapter_id");--> statement-breakpoint
CREATE INDEX "sections_tenant_id_idx" ON "sections" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_bank_question_id_question_bank_id_fk" FOREIGN KEY ("bank_question_id") REFERENCES "public"."question_bank"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chapters_module_id_idx" ON "chapters" USING btree ("module_id");--> statement-breakpoint
CREATE INDEX "chapters_tenant_id_idx" ON "chapters" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "chapters" DROP COLUMN "subject_id";