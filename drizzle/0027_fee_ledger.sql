CREATE TABLE "fee_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"type" varchar(20) NOT NULL,
	"amount" bigint NOT NULL,
	"invoice_id" uuid,
	"source_invoice_id" uuid,
	"payment_id" uuid,
	"reverses_id" uuid,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"receipt_no" varchar(40) NOT NULL,
	"financial_year" varchar(9) NOT NULL,
	"amount" bigint NOT NULL,
	"mode" varchar(20) NOT NULL,
	"reference" varchar(120),
	"instrument_date" date,
	"bank_name" varchar(120),
	"received_at" timestamp with time zone NOT NULL,
	"clearance_status" varchar(20) NOT NULL,
	"cleared_at" timestamp with time zone,
	"bounced_at" timestamp with time zone,
	"bounce_reason" text,
	"status" varchar(20) DEFAULT 'recorded' NOT NULL,
	"reversed_by" uuid,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	"recorded_by" uuid NOT NULL,
	"idempotency_key" varchar(64),
	"document_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_receipt_sequences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"series" varchar(20) NOT NULL,
	"financial_year" varchar(9) NOT NULL,
	"prefix" varchar(12) NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_reminder_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"offset_days" integer NOT NULL,
	"sent_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_guardians" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"relation" varchar(30) NOT NULL,
	"phone" varchar(20),
	"email" varchar(255),
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fee_invoices" ALTER COLUMN "assignment_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "fee_invoices" ALTER COLUMN "installment_seq" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "fee_invoices" ADD COLUMN "kind" varchar(20) DEFAULT 'installment' NOT NULL;--> statement-breakpoint
ALTER TABLE "fee_invoices" ADD COLUMN "waived_amount" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fee_invoices" ADD COLUMN "party_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "fee_invoices" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_fee_settings" ADD COLUMN "bounce_charge_amount" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_invoice_id_fee_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."fee_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_source_invoice_id_fee_invoices_id_fk" FOREIGN KEY ("source_invoice_id") REFERENCES "public"."fee_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_payment_id_fee_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."fee_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_reverses_id_fee_adjustments_id_fk" FOREIGN KEY ("reverses_id") REFERENCES "public"."fee_adjustments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_payment_allocations" ADD CONSTRAINT "fee_payment_allocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_payment_allocations" ADD CONSTRAINT "fee_payment_allocations_payment_id_fee_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."fee_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_payment_allocations" ADD CONSTRAINT "fee_payment_allocations_invoice_id_fee_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."fee_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_payments" ADD CONSTRAINT "fee_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_payments" ADD CONSTRAINT "fee_payments_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_payments" ADD CONSTRAINT "fee_payments_reversed_by_users_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_payments" ADD CONSTRAINT "fee_payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_receipt_sequences" ADD CONSTRAINT "fee_receipt_sequences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_reminder_log" ADD CONSTRAINT "fee_reminder_log_invoice_id_fee_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."fee_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_guardians" ADD CONSTRAINT "student_guardians_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_guardians" ADD CONSTRAINT "student_guardians_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fee_adjustments_student_idx" ON "fee_adjustments" USING btree ("tenant_id","student_id");--> statement-breakpoint
CREATE INDEX "fee_adjustments_invoice_id_idx" ON "fee_adjustments" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_adjustments_late_fee_once_uniq" ON "fee_adjustments" USING btree ("source_invoice_id") WHERE type = 'late_fee' AND reverses_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "fee_adjustments_bounce_charge_once_uniq" ON "fee_adjustments" USING btree ("payment_id") WHERE type = 'bounce_charge' AND reverses_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "fee_adjustments_reverses_uniq" ON "fee_adjustments" USING btree ("reverses_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_payment_allocations_payment_invoice_uniq" ON "fee_payment_allocations" USING btree ("payment_id","invoice_id");--> statement-breakpoint
CREATE INDEX "fee_payment_allocations_invoice_id_idx" ON "fee_payment_allocations" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_payments_tenant_receipt_uniq" ON "fee_payments" USING btree ("tenant_id","receipt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_payments_tenant_idempotency_uniq" ON "fee_payments" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "fee_payments_tenant_received_idx" ON "fee_payments" USING btree ("tenant_id","received_at");--> statement-breakpoint
CREATE INDEX "fee_payments_student_id_idx" ON "fee_payments" USING btree ("student_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_receipt_sequences_tenant_series_fy_uniq" ON "fee_receipt_sequences" USING btree ("tenant_id","series","financial_year");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_reminder_log_invoice_offset_uniq" ON "fee_reminder_log" USING btree ("invoice_id","offset_days");--> statement-breakpoint
CREATE INDEX "student_guardians_student_idx" ON "student_guardians" USING btree ("tenant_id","student_id");--> statement-breakpoint
CREATE UNIQUE INDEX "student_guardians_one_primary_uniq" ON "student_guardians" USING btree ("tenant_id","student_id") WHERE is_primary;--> statement-breakpoint
CREATE INDEX "fee_invoices_updated_at_idx" ON "fee_invoices" USING btree ("updated_at");