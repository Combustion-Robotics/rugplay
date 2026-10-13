CREATE TYPE "public"."stock_order_side" AS ENUM('BUY', 'SELL');--> statement-breakpoint
CREATE TABLE "stock_order" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"side" "stock_order_side" NOT NULL,
	"price" numeric(30, 8) NOT NULL,
	"shares" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_order_shares_positive" CHECK (shares > 0),
	CONSTRAINT "stock_order_price_positive" CHECK (price > 0)
);
--> statement-breakpoint
CREATE TABLE "stock_trade" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"buyer_id" integer,
	"seller_id" integer,
	"taker_side" "stock_order_side" NOT NULL,
	"price" numeric(30, 8) NOT NULL,
	"shares" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN "raised_cash" numeric(30, 8) DEFAULT '0.00000000' NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_order" ADD CONSTRAINT "stock_order_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_order" ADD CONSTRAINT "stock_order_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_trade" ADD CONSTRAINT "stock_trade_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_trade" ADD CONSTRAINT "stock_trade_buyer_id_user_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_trade" ADD CONSTRAINT "stock_trade_seller_id_user_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_order_book_idx" ON "stock_order" USING btree ("company_id","side","price");--> statement-breakpoint
CREATE INDEX "stock_order_user_id_idx" ON "stock_order" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "stock_trade_company_id_created_at_idx" ON "stock_trade" USING btree ("company_id","created_at");--> statement-breakpoint
ALTER TABLE "company_holding" ADD CONSTRAINT "company_holding_shares_non_negative" CHECK (shares >= 0);
--> statement-breakpoint
UPDATE "company" SET "raised_cash" = "round_shares_sold" * "share_price";
