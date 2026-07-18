CREATE TABLE `transaction_simulations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_email` text NOT NULL,
	`wallet_address` text NOT NULL,
	`quote_id` text NOT NULL,
	`position_address` text NOT NULL,
	`transaction_hash` text NOT NULL,
	`status` text NOT NULL,
	`slot` integer,
	`units_consumed` integer,
	`logs_json` text NOT NULL,
	`logs_hash` text NOT NULL,
	`error_json` text,
	`transaction_signature` text,
	`submission_status` text NOT NULL,
	`submission_error` text,
	`created_at` integer NOT NULL,
	`confirmed_at` integer
);
--> statement-breakpoint
CREATE INDEX `transaction_simulations_user_created_idx` ON `transaction_simulations` (`user_email`,`created_at`);--> statement-breakpoint
CREATE INDEX `transaction_simulations_quote_idx` ON `transaction_simulations` (`quote_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `transaction_simulations_hash_unique_idx` ON `transaction_simulations` (`transaction_hash`);--> statement-breakpoint
ALTER TABLE `positions` ADD `transaction_signature` text;--> statement-breakpoint
ALTER TABLE `positions` ADD `simulation_id` text;--> statement-breakpoint
ALTER TABLE `positions` ADD `simulation_status` text;--> statement-breakpoint
ALTER TABLE `positions` ADD `simulation_slot` integer;--> statement-breakpoint
ALTER TABLE `positions` ADD `simulation_units_consumed` integer;--> statement-breakpoint
ALTER TABLE `positions` ADD `simulation_logs_hash` text;--> statement-breakpoint
ALTER TABLE `rfq_quotes` ADD `volatility_source` text DEFAULT 'legacy' NOT NULL;