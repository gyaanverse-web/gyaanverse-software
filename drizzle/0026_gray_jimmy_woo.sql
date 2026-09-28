CREATE TABLE "fee_concessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_id" uuid NOT NULL,
	"head_id" uuid,
	"type" varchar(20) NOT NULL,
	"mode" varchar(10) NOT NULL,
	"value" numeric(10, 2) NOT NULL,
	"computed_amount" bigint NOT NULL,
	"reason" text,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_heads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"code" varchar(32) NOT NULL,
	"category" varchar(20) NOT NULL,
	"is_refundable" boolean DEFAULT false NOT NULL,
	"tax_rate_pct" numeric(5, 2),
	"sac_code" varchar(10),
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_invoice_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"head_id" uuid NOT NULL,
	"gross_amount" bigint NOT NULL,
	"concession_amount" bigint DEFAULT 0 NOT NULL,
	"taxable_amount" bigint NOT NULL,
	"tax_rate_pct" numeric(5, 2),
	"tax_amount" bigint DEFAULT 0 NOT NULL,
	"total_amount" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"installment_seq" integer NOT NULL,
	"label" varchar(80) NOT NULL,
	"invoice_no" varchar(40),
	"issue_date" date NOT NULL,
	"due_date" date NOT NULL,
	"gross_amount" bigint NOT NULL,
	"concession_amount" bigint DEFAULT 0 NOT NULL,
	"taxable_amount" bigint NOT NULL,
	"tax_amount" bigint DEFAULT 0 NOT NULL,
	"total_amount" bigint NOT NULL,
	"paid_amount" bigint DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'issued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_structure_installments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"structure_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"label" varchar(80) NOT NULL,
	"due_date" date NOT NULL,
	"share_pct" numeric(5, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_structure_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"structure_id" uuid NOT NULL,
	"head_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_structures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(160) NOT NULL,
	"academic_year" varchar(9) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"superseded_by_id" uuid,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_fee_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"structure_id" uuid NOT NULL,
	"academic_year" varchar(9) NOT NULL,
	"gross_amount" bigint NOT NULL,
	"concession_amount" bigint DEFAULT 0 NOT NULL,
	"net_amount" bigint NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"effective_from" date NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_fee_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"gst_mode" varchar(20) DEFAULT 'none' NOT NULL,
	"gstin" varchar(15),
	"place_of_supply_code" varchar(2),
	"receipt_prefix" varchar(12) NOT NULL,
	"financial_year_start_month" integer DEFAULT 4 NOT NULL,
	"late_fee_policy" jsonb NOT NULL,
	"reminder_policy" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fee_concessions" ADD CONSTRAINT "fee_concessions_assignment_id_student_fee_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."student_fee_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_concessions" ADD CONSTRAINT "fee_concessions_head_id_fee_heads_id_fk" FOREIGN KEY ("head_id") REFERENCES "public"."fee_heads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_concessions" ADD CONSTRAINT "fee_concessions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_heads" ADD CONSTRAINT "fee_heads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_invoice_items" ADD CONSTRAINT "fee_invoice_items_invoice_id_fee_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."fee_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_invoice_items" ADD CONSTRAINT "fee_invoice_items_head_id_fee_heads_id_fk" FOREIGN KEY ("head_id") REFERENCES "public"."fee_heads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_invoices" ADD CONSTRAINT "fee_invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_invoices" ADD CONSTRAINT "fee_invoices_assignment_id_student_fee_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."student_fee_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_invoices" ADD CONSTRAINT "fee_invoices_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_structure_installments" ADD CONSTRAINT "fee_structure_installments_structure_id_fee_structures_id_fk" FOREIGN KEY ("structure_id") REFERENCES "public"."fee_structures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_structure_items" ADD CONSTRAINT "fee_structure_items_structure_id_fee_structures_id_fk" FOREIGN KEY ("structure_id") REFERENCES "public"."fee_structures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_structure_items" ADD CONSTRAINT "fee_structure_items_head_id_fee_heads_id_fk" FOREIGN KEY ("head_id") REFERENCES "public"."fee_heads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_superseded_by_id_fee_structures_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."fee_structures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_fee_assignments" ADD CONSTRAINT "student_fee_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_fee_assignments" ADD CONSTRAINT "student_fee_assignments_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_fee_assignments" ADD CONSTRAINT "student_fee_assignments_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_fee_assignments" ADD CONSTRAINT "student_fee_assignments_structure_id_fee_structures_id_fk" FOREIGN KEY ("structure_id") REFERENCES "public"."fee_structures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_fee_settings" ADD CONSTRAINT "tenant_fee_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fee_concessions_assignment_id_idx" ON "fee_concessions" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "fee_heads_tenant_id_idx" ON "fee_heads" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_heads_tenant_code_uniq" ON "fee_heads" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "fee_invoice_items_invoice_id_idx" ON "fee_invoice_items" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "fee_invoices_tenant_status_due_idx" ON "fee_invoices" USING btree ("tenant_id","status","due_date");--> statement-breakpoint
CREATE INDEX "fee_invoices_student_id_idx" ON "fee_invoices" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "fee_invoices_assignment_id_idx" ON "fee_invoices" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "fee_structure_installments_structure_id_idx" ON "fee_structure_installments" USING btree ("structure_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_structure_installments_structure_seq_uniq" ON "fee_structure_installments" USING btree ("structure_id","seq");--> statement-breakpoint
CREATE INDEX "fee_structure_items_structure_id_idx" ON "fee_structure_items" USING btree ("structure_id");--> statement-breakpoint
CREATE INDEX "fee_structures_tenant_id_idx" ON "fee_structures" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "student_fee_assignments_tenant_id_idx" ON "student_fee_assignments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "student_fee_assignments_student_id_idx" ON "student_fee_assignments" USING btree ("student_id");--> statement-breakpoint
CREATE UNIQUE INDEX "student_fee_assignments_student_structure_year_uniq" ON "student_fee_assignments" USING btree ("student_id","structure_id","academic_year");