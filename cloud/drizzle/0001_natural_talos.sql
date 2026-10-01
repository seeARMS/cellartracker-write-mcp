CREATE TABLE `inventory_snapshots` (
	`owner` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`snapshot_id` text,
	`body` text,
	`fetched_at` integer DEFAULT 0 NOT NULL,
	`expires_at` integer DEFAULT 0 NOT NULL,
	`lease_id` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`retry_at` integer DEFAULT 0 NOT NULL,
	`retry_code` text
);
