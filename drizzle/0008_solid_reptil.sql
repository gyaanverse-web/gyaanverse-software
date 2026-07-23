ALTER TABLE "enrollments" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "enrollments" CASCADE;--> statement-breakpoint
DROP INDEX "join_codes_tenant_id_idx";--> statement-breakpoint
ALTER TABLE "join_codes" ALTER COLUMN "expires_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "join_codes" ADD COLUMN "created_by" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "class_members" ADD COLUMN "status" varchar(20) DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE "classes" ADD COLUMN "auto_approve" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "join_codes" ADD CONSTRAINT "join_codes_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_codes" ADD CONSTRAINT "join_codes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "join_codes_class_id_idx" ON "join_codes" USING btree ("class_id");--> statement-breakpoint
CREATE UNIQUE INDEX "class_members_class_student_uniq" ON "class_members" USING btree ("class_id","student_id");