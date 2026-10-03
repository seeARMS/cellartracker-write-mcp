CREATE TABLE `provider_cooldowns` (
	`owner` text NOT NULL,
	`account_id` text NOT NULL,
	`retry_at` integer NOT NULL,
	`source` text NOT NULL,
	PRIMARY KEY(`owner`, `account_id`)
);
