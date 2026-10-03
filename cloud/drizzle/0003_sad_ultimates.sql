CREATE TABLE `provider_request_slots` (
	`owner` text NOT NULL,
	`account_id` text NOT NULL,
	`next_at` integer NOT NULL,
	PRIMARY KEY(`owner`, `account_id`)
);
