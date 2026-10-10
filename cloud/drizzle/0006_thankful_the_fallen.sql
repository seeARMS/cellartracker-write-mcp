CREATE TABLE `reconciliation_reads` (
	`owner` text NOT NULL,
	`operation_id` text NOT NULL,
	`scope` text NOT NULL,
	`generation_id` text NOT NULL,
	`body` text NOT NULL,
	`started_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`lease_id` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`owner`, `operation_id`),
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE no action
);
