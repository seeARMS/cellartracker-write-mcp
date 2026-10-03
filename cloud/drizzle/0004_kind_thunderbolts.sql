CREATE TABLE `pending_requests` (
	`owner` text NOT NULL,
	`request_key` text NOT NULL,
	`operation_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`retry_at` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease_id` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`error` text,
	PRIMARY KEY(`owner`, `request_key`)
);
--> statement-breakpoint
CREATE TABLE `provider_state` (
	`owner` text PRIMARY KEY NOT NULL,
	`lease_id` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`last_failure_at` integer DEFAULT 0 NOT NULL,
	`blocked_code` text
);
--> statement-breakpoint
ALTER TABLE `operations` ADD `checking_token` text;--> statement-breakpoint
ALTER TABLE `operations` ADD `checking_until` integer;