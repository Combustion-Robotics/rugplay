CREATE TYPE "public"."company_sector" AS ENUM('Tech', 'Food', 'Games', 'Energy', 'Health', 'Retail');--> statement-breakpoint
CREATE TYPE "public"."company_status" AS ENUM('PRIVATE', 'PUBLIC', 'BANKRUPT');--> statement-breakpoint
CREATE TABLE "company" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(40) NOT NULL,
	"symbol" varchar(5) NOT NULL,
	"sector" "company_sector" NOT NULL,
	"pitch" varchar(1000) NOT NULL,
	"founder_id" integer,
	"status" "company_status" DEFAULT 'PRIVATE' NOT NULL,
	"share_price" numeric(30, 8) NOT NULL,
	"shares_outstanding" integer NOT NULL,
	"round_shares" integer NOT NULL,
	"round_shares_sold" integer DEFAULT 0 NOT NULL,
	"round_ends_at" timestamp with time zone NOT NULL,
	"treasury_cash" numeric(30, 8) DEFAULT '0.00000000' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_symbol_unique" UNIQUE("symbol"),
	CONSTRAINT "company_round_not_overfilled" CHECK (round_shares_sold <= round_shares)
);
--> statement-breakpoint
CREATE TABLE "company_holding" (
	"user_id" integer NOT NULL,
	"company_id" integer NOT NULL,
	"shares" integer NOT NULL,
	CONSTRAINT "company_holding_user_id_company_id_pk" PRIMARY KEY("user_id","company_id")
);
--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_founder_id_user_id_fk" FOREIGN KEY ("founder_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_holding" ADD CONSTRAINT "company_holding_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_holding" ADD CONSTRAINT "company_holding_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_founder_id_idx" ON "company" USING btree ("founder_id");--> statement-breakpoint
CREATE INDEX "company_created_at_idx" ON "company" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "company_holding_company_id_shares_idx" ON "company_holding" USING btree ("company_id","shares" DESC NULLS LAST);