CREATE TABLE `account_locks` (
	`owner` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `bottle_claims` (
	`owner` text NOT NULL,
	`account_id` text NOT NULL,
	`bottle_id` text NOT NULL,
	`operation_id` text NOT NULL,
	PRIMARY KEY(`owner`, `account_id`, `bottle_id`),
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `claims_operation` ON `bottle_claims` (`operation_id`);--> statement-breakpoint
CREATE TABLE `operations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`request_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`account_id` text NOT NULL,
	`body` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`submitted_at` integer,
	`observation` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operations_owner_request` ON `operations` (`owner`,`request_key`);--> statement-breakpoint
CREATE INDEX `operations_owner_status` ON `operations` (`owner`,`status`,`expires_at`);