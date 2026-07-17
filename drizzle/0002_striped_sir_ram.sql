CREATE TABLE `rfq_quotes` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`maker` text NOT NULL,
	`symbol` text NOT NULL,
	`direction` text NOT NULL,
	`amount` real NOT NULL,
	`premium` real NOT NULL,
	`max_payout` real NOT NULL,
	`strike` real NOT NULL,
	`cap_price` real NOT NULL,
	`breakeven` real NOT NULL,
	`implied_volatility` real NOT NULL,
	`effective_leverage` real NOT NULL,
	`latency_ms` integer NOT NULL,
	`badge` text NOT NULL,
	`expiry_days` integer NOT NULL,
	`payoff` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rfq_quotes_expiry_idx` ON `rfq_quotes` (`expires_at`);