CREATE TYPE "public"."company_spending" AS ENUM('LOW', 'MEDIUM', 'HIGH');--> statement-breakpoint
CREATE TABLE "company_earnings" (
	"company_id" integer NOT NULL,
	"quarter" integer NOT NULL,
	"spending_level" "company_spending" NOT NULL,
	"sector_multiplier" numeric(3, 2) NOT NULL,
	"revenue" numeric(30, 8) NOT NULL,
	"spending" numeric(30, 8) NOT NULL,
	"profit" numeric(30, 8) NOT NULL,
	"cash_after" numeric(30, 8) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_earnings_company_id_quarter_pk" PRIMARY KEY("company_id","quarter")
);
--> statement-breakpoint
CREATE TABLE "sector_condition" (
	"sector" "company_sector" PRIMARY KEY NOT NULL,
	"multiplier" numeric(3, 2) DEFAULT '1.00' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN "spending_level" "company_spending" DEFAULT 'MEDIUM' NOT NULL;--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN "next_quarter_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "company_earnings" ADD CONSTRAINT "company_earnings_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE cascade ON UPDATE no action;