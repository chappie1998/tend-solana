CREATE TABLE `liquidity_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_email` text NOT NULL,
	`wallet_address` text NOT NULL,
	`pool_address` text NOT NULL,
	`provider_address` text NOT NULL,
	`action` text NOT NULL,
	`amount_atoms` text NOT NULL,
	`minimum_output_atoms` text NOT NULL,
	`shares_atoms` text,
	`deadline` integer NOT NULL,
	`transaction_message_hash` text NOT NULL,
	`transaction_hash` text,
	`simulation_status` text,
	`simulation_slot` integer,
	`simulation_units_consumed` integer,
	`simulation_logs_json` text,
	`simulation_logs_hash` text,
	`simulation_error_json` text,
	`transaction_signature` text,
	`submission_status` text NOT NULL,
	`submission_error` text,
	`pre_wallet_atoms` text NOT NULL,
	`pre_pool_atoms` text NOT NULL,
	`pre_shares_atoms` text NOT NULL,
	`post_wallet_atoms` text,
	`post_pool_atoms` text,
	`post_shares_atoms` text,
	`created_at` integer NOT NULL,
	`confirmed_at` integer
);
--> statement-breakpoint
CREATE INDEX `liquidity_actions_user_created_idx` ON `liquidity_actions` (`user_email`,`created_at`);--> statement-breakpoint
CREATE INDEX `liquidity_actions_wallet_created_idx` ON `liquidity_actions` (`wallet_address`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `liquidity_actions_message_unique_idx` ON `liquidity_actions` (`transaction_message_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `liquidity_actions_transaction_hash_unique_idx` ON `liquidity_actions` (`transaction_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `liquidity_actions_signature_unique_idx` ON `liquidity_actions` (`transaction_signature`);--> statement-breakpoint
ALTER TABLE `positions` ADD `market_address` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `positions` ADD `oracle_address` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `rfq_quotes` ADD `market_address` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `rfq_quotes` ADD `oracle_address` text DEFAULT '' NOT NULL;