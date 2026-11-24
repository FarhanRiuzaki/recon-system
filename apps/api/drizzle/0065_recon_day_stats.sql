CREATE TABLE "recon_day_stats" (
	"space_id" uuid NOT NULL,
	"config_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"results" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"broke" integer DEFAULT 0 NOT NULL,
	"written_off" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolve_minutes" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recon_day_stats_pkey" PRIMARY KEY("space_id","config_id","business_date")
);
--> statement-breakpoint
ALTER TABLE "recon_day_stats" ADD CONSTRAINT "recon_day_stats_config_fkey" FOREIGN KEY ("space_id","config_id") REFERENCES "recon_configs"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recon_day_stats_date" ON "recon_day_stats" USING btree ("space_id","business_date");--> statement-breakpoint
select recon_enable_space_rls('recon_day_stats');