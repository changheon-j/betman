CREATE TABLE `api_response_cache` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`payload_json` text,
	`fetched_at` text,
	`expires_at` integer DEFAULT 0 NOT NULL,
	`stale_until` integer DEFAULT 0 NOT NULL,
	`lease_token` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_api_response_cache_stale_until` ON `api_response_cache` (`stale_until`);