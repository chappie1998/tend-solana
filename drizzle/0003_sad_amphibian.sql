ALTER TABLE `positions` ADD `expiry_code` text DEFAULT '7D' NOT NULL;--> statement-breakpoint
ALTER TABLE `positions` ADD `option_expiry_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `positions` ADD `observation_window_seconds` integer DEFAULT 900 NOT NULL;--> statement-breakpoint
ALTER TABLE `positions` ADD `trade_lock_seconds` integer DEFAULT 300 NOT NULL;--> statement-breakpoint
ALTER TABLE `rfq_quotes` ADD `expiry_code` text DEFAULT '7D' NOT NULL;--> statement-breakpoint
ALTER TABLE `rfq_quotes` ADD `option_expiry_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `rfq_quotes` ADD `observation_window_seconds` integer DEFAULT 900 NOT NULL;--> statement-breakpoint
ALTER TABLE `rfq_quotes` ADD `trade_lock_seconds` integer DEFAULT 300 NOT NULL;
