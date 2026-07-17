CREATE TABLE `positions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_email` text NOT NULL,
	`wallet_address` text NOT NULL,
	`quote_id` text NOT NULL,
	`maker` text NOT NULL,
	`symbol` text NOT NULL,
	`direction` text NOT NULL,
	`amount` real NOT NULL,
	`premium` real NOT NULL,
	`strike` real NOT NULL,
	`cap_price` real NOT NULL,
	`expiry_days` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `positions_user_created_idx` ON `positions` (`user_email`,`created_at`);--> statement-breakpoint
CREATE INDEX `positions_wallet_idx` ON `positions` (`wallet_address`);
