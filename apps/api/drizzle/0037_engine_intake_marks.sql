CREATE TABLE "recon_intake_marks" (
	"space_id" uuid NOT NULL,
	"config_version_id" uuid NOT NULL,
	"side" text NOT NULL,
	"business_date" date NOT NULL,
	"seq" bigint NOT NULL,
	CONSTRAINT "recon_intake_marks_pkey" PRIMARY KEY("space_id","config_version_id","side","business_date")
);
--> statement-breakpoint
DROP INDEX "records_source_date";--> statement-breakpoint
ALTER TABLE "records" ADD COLUMN "seq" bigint NOT NULL GENERATED ALWAYS AS IDENTITY (sequence name "records_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1);--> statement-breakpoint
ALTER TABLE "recon_intake_marks" ADD CONSTRAINT "recon_intake_marks_version_fkey" FOREIGN KEY ("config_version_id") REFERENCES "recon_config_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "records_source_seq" ON "records" USING btree ("space_id","source_id","business_date","seq");--> statement-breakpoint
select recon_enable_space_rls('recon_intake_marks');
