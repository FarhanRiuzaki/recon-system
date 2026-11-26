CREATE TABLE "trusted_devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"ip" text NOT NULL,
	"bound_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"cap_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trusted_devices_token_hash_key" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "auth_log" DROP CONSTRAINT "auth_log_event_check";--> statement-breakpoint
ALTER TABLE "auth_log" DROP CONSTRAINT "auth_log_method_check";--> statement-breakpoint
ALTER TABLE "auth_challenges" DROP CONSTRAINT "auth_challenges_method_check";--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_method_check";--> statement-breakpoint
ALTER TABLE "auth_challenges" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "trusted_devices" ADD CONSTRAINT "trusted_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trusted_devices_user_id" ON "trusted_devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "trusted_devices_expires_at" ON "trusted_devices" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "trusted_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_log" ADD CONSTRAINT "auth_log_event_check" CHECK (event in ('login_success', 'password_ok', 'login_failed', 'logout', '2fa_success', '2fa_failed', 'password_reset', 'device_trusted', 'device_revoked'));--> statement-breakpoint
ALTER TABLE "auth_log" ADD CONSTRAINT "auth_log_method_check" CHECK (method in ('password', 'ldap', 'google', 'apple', 'device'));--> statement-breakpoint
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_method_check" CHECK (method in ('password', 'ldap', 'google', 'apple', 'device'));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_method_check" CHECK (method in ('password', 'ldap', 'google', 'apple', 'device'));