CREATE TABLE "coaching_join_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"code" varchar(10) NOT NULL,
	"expires_at" timestamp with time zone,
	"max_uses" integer DEFAULT 9999 NOT NULL,
	"used_count" integer DEFAULT 0 NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coaching_join_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "coaching_join_codes" ADD CONSTRAINT "coaching_join_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coaching_join_codes" ADD CONSTRAINT "coaching_join_codes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coaching_join_codes_tenant_id_idx" ON "coaching_join_codes" USING btree ("tenant_id");