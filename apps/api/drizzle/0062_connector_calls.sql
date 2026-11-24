CREATE TABLE "connector_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connector_id" uuid NOT NULL,
	"connector_version" integer,
	"environment" text NOT NULL,
	"operation_key" text,
	"method" text NOT NULL,
	"host" text NOT NULL,
	"path" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"attempt" smallint DEFAULT 1 NOT NULL,
	"outcome" text NOT NULL,
	"http_status" smallint,
	"code" text,
	"message" text,
	"external_id" text,
	"request_masked" jsonb,
	"response_masked" jsonb,
	"full_enc" text,
	"origin" jsonb NOT NULL,
	"actor_id" uuid,
	"on_behalf_of" uuid,
	CONSTRAINT "connector_calls_outcome_check" CHECK ("connector_calls"."outcome" in ('ok', 'rejected', 'timeout', 'not_sent'))
);
--> statement-breakpoint
ALTER TABLE "connector_calls" ADD CONSTRAINT "connector_calls_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connector_calls_started" ON "connector_calls" USING btree ("started_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "connector_calls_connector" ON "connector_calls" USING btree ("connector_id","started_at");