CREATE TABLE "recon_alerts" (
	"space_id" uuid NOT NULL,
	"config_id" uuid NOT NULL,
	"alerted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "recon_alerts_pkey" PRIMARY KEY("space_id","config_id")
);
--> statement-breakpoint
ALTER TABLE "recon_alerts" ADD CONSTRAINT "recon_alerts_config_fkey" FOREIGN KEY ("space_id","config_id") REFERENCES "recon_configs"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recon_items_breaks" ON "recon_items" USING btree ("space_id","config_id") WHERE "recon_items"."status" = 'break' and "recon_items"."sim_run_id" is null;--> statement-breakpoint
select recon_enable_space_rls('recon_alerts');