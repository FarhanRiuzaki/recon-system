CREATE TABLE "inbox_uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"folder" text NOT NULL,
	"name" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"uploaded_by" uuid,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inbox_uploads" ADD CONSTRAINT "inbox_uploads_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_uploads" ADD CONSTRAINT "inbox_uploads_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_uploads_file_key" ON "inbox_uploads" USING btree ("space_id","folder","name","sha256");--> statement-breakpoint
CREATE INDEX "inbox_uploads_folder" ON "inbox_uploads" USING btree ("space_id","folder");