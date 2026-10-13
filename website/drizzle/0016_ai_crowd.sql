CREATE TYPE "public"."crowd_archetype" AS ENUM('RETAIL', 'FUND', 'TRADER');--> statement-breakpoint
CREATE TYPE "public"."crowd_market" AS ENUM('STOCK', 'COIN');--> statement-breakpoint
CREATE TABLE "crowd_asset" (
	"id" serial PRIMARY KEY NOT NULL,
	"market" "crowd_market" NOT NULL,
	"asset_id" integer NOT NULL,
	"next_tick_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_eval_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_eval_price" numeric(30, 8),
	"last_quarter" integer DEFAULT 0 NOT NULL,
	"mood" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "crowd_asset_market_asset_unique" UNIQUE("market","asset_id")
);
--> statement-breakpoint
CREATE TABLE "crowd_decision" (
	"id" serial PRIMARY KEY NOT NULL,
	"market" "crowd_market" NOT NULL,
	"asset_id" integer NOT NULL,
	"symbol" varchar(10) NOT NULL,
	"archetype" "crowd_archetype" NOT NULL,
	"source" varchar(10) NOT NULL,
	"model" varchar(100),
	"context" text NOT NULL,
	"p_buy" numeric(5, 4) NOT NULL,
	"p_sell" numeric(5, 4) NOT NULL,
	"p_hold" numeric(5, 4) NOT NULL,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crowd_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"coins_enabled" boolean DEFAULT false NOT NULL,
	"coin_pool" numeric(30, 8) DEFAULT '100000.00000000' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crowd_settings_single_row" CHECK (id = 1)
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "is_bot" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "crowd_asset_next_tick_at_idx" ON "crowd_asset" USING btree ("next_tick_at");--> statement-breakpoint
CREATE INDEX "crowd_decision_created_at_idx" ON "crowd_decision" USING btree ("created_at");