DROP INDEX "notif_pref_user_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "notif_pref_user_type_uniq" ON "notification_preferences" USING btree ("user_id","type");