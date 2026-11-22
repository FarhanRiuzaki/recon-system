CREATE TABLE "connector_external_ids" (
	"connector_id" uuid NOT NULL,
	"day" date NOT NULL,
	"n" bigint NOT NULL,
	CONSTRAINT "connector_external_ids_pkey" PRIMARY KEY("connector_id","day")
);
--> statement-breakpoint
CREATE TABLE "connector_secrets" (
	"connector_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"secret_enc" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_secrets_pkey" PRIMARY KEY("connector_id","environment")
);
--> statement-breakpoint
CREATE TABLE "connector_tokens" (
	"connector_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"token_enc" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "connector_tokens_pkey" PRIMARY KEY("connector_id","environment")
);
--> statement-breakpoint
CREATE TABLE "connector_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connector_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"spec" jsonb NOT NULL,
	"maker_id" uuid,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"review_comment" text,
	"override_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_versions_status_check" CHECK (status in ('draft', 'in_review', 'published', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "connectors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_reason" text,
	"disabled_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connector_external_ids" ADD CONSTRAINT "connector_external_ids_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_secrets" ADD CONSTRAINT "connector_secrets_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_tokens" ADD CONSTRAINT "connector_tokens_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_versions" ADD CONSTRAINT "connector_versions_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_versions_one_open" ON "connector_versions" USING btree ("connector_id") WHERE "connector_versions"."status" in ('draft', 'in_review');--> statement-breakpoint
CREATE UNIQUE INDEX "connector_versions_one_published" ON "connector_versions" USING btree ("connector_id") WHERE "connector_versions"."status" = 'published';--> statement-breakpoint
CREATE UNIQUE INDEX "connector_versions_version" ON "connector_versions" USING btree ("connector_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "connectors_name" ON "connectors" USING btree (lower("name"));