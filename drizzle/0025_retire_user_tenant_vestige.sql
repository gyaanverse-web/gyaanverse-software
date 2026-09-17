ALTER TABLE "users" DROP CONSTRAINT "users_tenant_id_tenants_id_fk";--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "role" TO "account_role";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "tenant_id";
