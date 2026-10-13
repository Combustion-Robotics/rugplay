-- Re-adds 0006_mention_notifications and 0007_user_blocks, which were never in _journal.json.
-- Idempotent, so it is safe on databases where they were applied by hand.
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'MENTION';--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "disable_mentions" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_block" (
	"id" serial PRIMARY KEY NOT NULL,
	"blocker_id" integer NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
	"blocked_id" integer NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_block_unique" UNIQUE("blocker_id","blocked_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_block_blocker_id_idx" ON "user_block" ("blocker_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_block_blocked_id_idx" ON "user_block" ("blocked_id");
