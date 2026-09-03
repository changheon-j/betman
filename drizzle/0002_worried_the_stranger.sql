CREATE TABLE `betman_round_sources` (
	`slot` integer PRIMARY KEY NOT NULL,
	`source_url` text NOT NULL,
	`gm_id` text NOT NULL,
	`gm_ts` text NOT NULL,
	`updated_at` text NOT NULL
);
