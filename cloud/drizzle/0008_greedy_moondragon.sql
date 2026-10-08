CREATE TABLE `provider_error_details` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`account_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`body` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `provider_errors_owner_time` ON `provider_error_details` (`owner`,`created_at`);