CREATE TABLE `close_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`wallet_address` text NOT NULL,
	`position_address` text NOT NULL,
	`pool_address` text NOT NULL,
	`market_address` text NOT NULL,
	`buyer_destination_address` text NOT NULL,
	`treasury_destination_address` text NOT NULL,
	`buyback_amount_atoms` text NOT NULL,
	`min_proceeds_atoms` text NOT NULL,
	`fair_value_atoms` text NOT NULL,
	`spread_bps` real NOT NULL,
	`quote_expiry` integer NOT NULL,
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
	`pre_buyer_atoms` text NOT NULL,
	`post_buyer_atoms` text,
	`post_state_verified` integer,
	`created_at` integer NOT NULL,
	`confirmed_at` integer
);
--> statement-breakpoint
CREATE INDEX `close_actions_wallet_created_idx` ON `close_actions` (`wallet_address`,`created_at`);--> statement-breakpoint
CREATE INDEX `close_actions_position_idx` ON `close_actions` (`position_address`);--> statement-breakpoint
CREATE UNIQUE INDEX `close_actions_message_unique_idx` ON `close_actions` (`transaction_message_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `close_actions_transaction_hash_unique_idx` ON `close_actions` (`transaction_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `close_actions_signature_unique_idx` ON `close_actions` (`transaction_signature`);