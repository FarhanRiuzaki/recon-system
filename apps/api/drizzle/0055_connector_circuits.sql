CREATE TABLE "connector_circuits" (
	"connector_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"open_until" timestamp with time zone,
	CONSTRAINT "connector_circuits_pkey" PRIMARY KEY("connector_id","environment")
);
--> statement-breakpoint
ALTER TABLE "connector_circuits" ADD CONSTRAINT "connector_circuits_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE cascade ON UPDATE no action;