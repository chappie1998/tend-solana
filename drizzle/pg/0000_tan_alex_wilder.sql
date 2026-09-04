CREATE TABLE "auth_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "close_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet_address" text NOT NULL,
	"position_address" text NOT NULL,
	"pool_address" text NOT NULL,
	"market_address" text NOT NULL,
	"buyer_destination_address" text NOT NULL,
	"treasury_destination_address" text NOT NULL,
	"buyback_amount_atoms" text NOT NULL,
	"min_proceeds_atoms" text NOT NULL,
	"fair_value_atoms" text NOT NULL,
	"spread_bps" double precision NOT NULL,
	"quote_expiry" integer NOT NULL,
	"transaction_message_hash" text NOT NULL,
	"transaction_hash" text,
	"simulation_status" text,
	"simulation_slot" integer,
	"simulation_units_consumed" integer,
	"simulation_logs_json" text,
	"simulation_logs_hash" text,
	"simulation_error_json" text,
	"transaction_signature" text,
	"submission_status" text NOT NULL,
	"submission_error" text,
	"pre_buyer_atoms" text NOT NULL,
	"post_buyer_atoms" text,
	"post_state_verified" boolean,
	"created_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "launch_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_key" text NOT NULL,
	"wallet_address" text NOT NULL,
	"kind" text NOT NULL,
	"params_json" text NOT NULL,
	"target_address" text NOT NULL,
	"secondary_address" text,
	"transaction_message_hash" text NOT NULL,
	"transaction_hash" text,
	"simulation_status" text,
	"simulation_slot" integer,
	"simulation_units_consumed" integer,
	"simulation_logs_json" text,
	"simulation_logs_hash" text,
	"simulation_error_json" text,
	"transaction_signature" text,
	"submission_status" text NOT NULL,
	"submission_error" text,
	"post_state_verified" boolean,
	"created_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "liquidity_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_email" text NOT NULL,
	"wallet_address" text NOT NULL,
	"pool_address" text NOT NULL,
	"provider_address" text NOT NULL,
	"action" text NOT NULL,
	"amount_atoms" text NOT NULL,
	"minimum_output_atoms" text NOT NULL,
	"shares_atoms" text,
	"deadline" integer NOT NULL,
	"transaction_message_hash" text NOT NULL,
	"transaction_hash" text,
	"simulation_status" text,
	"simulation_slot" integer,
	"simulation_units_consumed" integer,
	"simulation_logs_json" text,
	"simulation_logs_hash" text,
	"simulation_error_json" text,
	"transaction_signature" text,
	"submission_status" text NOT NULL,
	"submission_error" text,
	"pre_wallet_atoms" text NOT NULL,
	"pre_pool_atoms" text NOT NULL,
	"pre_shares_atoms" text NOT NULL,
	"post_wallet_atoms" text,
	"post_pool_atoms" text,
	"post_shares_atoms" text,
	"created_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_email" text NOT NULL,
	"wallet_address" text NOT NULL,
	"quote_id" text NOT NULL,
	"market_address" text DEFAULT '' NOT NULL,
	"oracle_address" text DEFAULT '' NOT NULL,
	"maker" text NOT NULL,
	"symbol" text NOT NULL,
	"direction" text NOT NULL,
	"amount" double precision NOT NULL,
	"premium" double precision NOT NULL,
	"strike" double precision NOT NULL,
	"cap_price" double precision NOT NULL,
	"expiry_days" integer NOT NULL,
	"expiry_code" text DEFAULT '7D' NOT NULL,
	"option_expiry_at" timestamp with time zone DEFAULT to_timestamp(0) NOT NULL,
	"observation_window_seconds" integer DEFAULT 900 NOT NULL,
	"trade_lock_seconds" integer DEFAULT 300 NOT NULL,
	"status" text NOT NULL,
	"transaction_signature" text,
	"simulation_id" text,
	"simulation_status" text,
	"simulation_slot" integer,
	"simulation_units_consumed" integer,
	"simulation_logs_hash" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rfq_quotes" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"market_address" text DEFAULT '' NOT NULL,
	"oracle_address" text DEFAULT '' NOT NULL,
	"maker" text NOT NULL,
	"symbol" text NOT NULL,
	"direction" text NOT NULL,
	"amount" double precision NOT NULL,
	"premium" double precision NOT NULL,
	"max_payout" double precision NOT NULL,
	"strike" double precision NOT NULL,
	"cap_price" double precision NOT NULL,
	"breakeven" double precision NOT NULL,
	"implied_volatility" double precision NOT NULL,
	"volatility_source" text DEFAULT 'legacy' NOT NULL,
	"effective_leverage" double precision NOT NULL,
	"latency_ms" integer NOT NULL,
	"badge" text NOT NULL,
	"expiry_days" integer NOT NULL,
	"expiry_code" text DEFAULT '7D' NOT NULL,
	"option_expiry_at" timestamp with time zone DEFAULT to_timestamp(0) NOT NULL,
	"observation_window_seconds" integer DEFAULT 900 NOT NULL,
	"trade_lock_seconds" integer DEFAULT 300 NOT NULL,
	"payoff" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_simulations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_email" text NOT NULL,
	"wallet_address" text NOT NULL,
	"quote_id" text NOT NULL,
	"position_address" text NOT NULL,
	"transaction_hash" text NOT NULL,
	"status" text NOT NULL,
	"slot" integer,
	"units_consumed" integer,
	"logs_json" text NOT NULL,
	"logs_hash" text NOT NULL,
	"error_json" text,
	"transaction_signature" text,
	"submission_status" text NOT NULL,
	"submission_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "auth_nonces_expires_idx" ON "auth_nonces" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "close_actions_wallet_created_idx" ON "close_actions" USING btree ("wallet_address","created_at");--> statement-breakpoint
CREATE INDEX "close_actions_position_idx" ON "close_actions" USING btree ("position_address");--> statement-breakpoint
CREATE UNIQUE INDEX "close_actions_message_unique_idx" ON "close_actions" USING btree ("transaction_message_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "close_actions_transaction_hash_unique_idx" ON "close_actions" USING btree ("transaction_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "close_actions_signature_unique_idx" ON "close_actions" USING btree ("transaction_signature");--> statement-breakpoint
CREATE INDEX "launch_actions_user_created_idx" ON "launch_actions" USING btree ("user_key","created_at");--> statement-breakpoint
CREATE INDEX "launch_actions_wallet_created_idx" ON "launch_actions" USING btree ("wallet_address","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "launch_actions_message_unique_idx" ON "launch_actions" USING btree ("transaction_message_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "launch_actions_transaction_hash_unique_idx" ON "launch_actions" USING btree ("transaction_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "launch_actions_signature_unique_idx" ON "launch_actions" USING btree ("transaction_signature");--> statement-breakpoint
CREATE INDEX "liquidity_actions_user_created_idx" ON "liquidity_actions" USING btree ("user_email","created_at");--> statement-breakpoint
CREATE INDEX "liquidity_actions_wallet_created_idx" ON "liquidity_actions" USING btree ("wallet_address","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "liquidity_actions_message_unique_idx" ON "liquidity_actions" USING btree ("transaction_message_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "liquidity_actions_transaction_hash_unique_idx" ON "liquidity_actions" USING btree ("transaction_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "liquidity_actions_signature_unique_idx" ON "liquidity_actions" USING btree ("transaction_signature");--> statement-breakpoint
CREATE INDEX "positions_user_created_idx" ON "positions" USING btree ("user_email","created_at");--> statement-breakpoint
CREATE INDEX "positions_wallet_idx" ON "positions" USING btree ("wallet_address");--> statement-breakpoint
CREATE UNIQUE INDEX "positions_quote_unique_idx" ON "positions" USING btree ("quote_id");--> statement-breakpoint
CREATE INDEX "rfq_quotes_expiry_idx" ON "rfq_quotes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "transaction_simulations_user_created_idx" ON "transaction_simulations" USING btree ("user_email","created_at");--> statement-breakpoint
CREATE INDEX "transaction_simulations_quote_idx" ON "transaction_simulations" USING btree ("quote_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_simulations_hash_unique_idx" ON "transaction_simulations" USING btree ("transaction_hash");