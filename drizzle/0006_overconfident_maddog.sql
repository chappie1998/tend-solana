CREATE TABLE `auth_nonces` (
	`nonce` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
--> statement-breakpoint
CREATE INDEX `auth_nonces_expires_idx` ON `auth_nonces` (`expires_at`);--> statement-breakpoint
CREATE TABLE `launch_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_key` text NOT NULL,
	`wallet_address` text NOT NULL,
	`kind` text NOT NULL,
	`params_json` text NOT NULL,
	`target_address` text NOT NULL,
	`secondary_address` text,
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
	`post_state_verified` integer,
	`created_at` integer NOT NULL,
	`confirmed_at` integer
);
--> statement-breakpoint
CREATE INDEX `launch_actions_user_created_idx` ON `launch_actions` (`user_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `launch_actions_wallet_created_idx` ON `launch_actions` (`wallet_address`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `launch_actions_message_unique_idx` ON `launch_actions` (`transaction_message_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `launch_actions_transaction_hash_unique_idx` ON `launch_actions` (`transaction_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `launch_actions_signature_unique_idx` ON `launch_actions` (`transaction_signature`);