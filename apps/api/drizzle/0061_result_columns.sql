CREATE TABLE "recon_result_columns" (
	"space_id" uuid NOT NULL,
	"config_id" uuid NOT NULL,
	"columns" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recon_result_columns_pkey" PRIMARY KEY("space_id","config_id")
);
--> statement-breakpoint
ALTER TABLE "recon_result_columns" ADD CONSTRAINT "recon_result_columns_config_fkey" FOREIGN KEY ("space_id","config_id") REFERENCES "recon_configs"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
select recon_enable_space_rls('recon_result_columns');
