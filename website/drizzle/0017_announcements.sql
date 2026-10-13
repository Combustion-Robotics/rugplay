CREATE TYPE "public"."announcement_claim" AS ENUM('PROFIT', 'REVENUE_UP');--> statement-breakpoint
CREATE TABLE "company_announcement" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"author_id" integer,
	"text" varchar(200) NOT NULL,
	"claim" "announcement_claim",
	"claim_result" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crowd_asset" ADD COLUMN "last_announcement_id" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "crowd_decision" ADD COLUMN "reason" varchar(100);--> statement-breakpoint
ALTER TABLE "company_announcement" ADD CONSTRAINT "company_announcement_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_announcement" ADD CONSTRAINT "company_announcement_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_announcement_company_id_idx" ON "company_announcement" USING btree ("company_id","id");--> statement-breakpoint
CREATE INDEX "company_announcement_author_id_idx" ON "company_announcement" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "crowd_decision_asset_id_created_at_idx" ON "crowd_decision" USING btree ("asset_id","created_at");