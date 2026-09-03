CREATE TABLE `betman_history_matches` (
	`source_key` text PRIMARY KEY NOT NULL,
	`round_key` text NOT NULL,
	`gm_id` text NOT NULL,
	`gm_ts` text NOT NULL,
	`match_seq` text NOT NULL,
	`league_code` text NOT NULL,
	`league_name` text NOT NULL,
	`betman_league_name` text NOT NULL,
	`kickoff_at` text NOT NULL,
	`match_date` text NOT NULL,
	`home_team_id` integer,
	`away_team_id` integer,
	`home_team_name` text,
	`away_team_name` text,
	`betman_home_team` text NOT NULL,
	`betman_away_team` text NOT NULL,
	`home_score` integer,
	`away_score` integer,
	`result` text,
	`home_odds` real,
	`draw_odds` real,
	`away_odds` real,
	`display_status` text NOT NULL,
	`source_final` integer DEFAULT 0 NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`finalized_at` text,
	FOREIGN KEY (`round_key`) REFERENCES `betman_history_rounds`(`round_key`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_betman_history_match_league" CHECK("betman_history_matches"."league_code" in ('K1', 'J1')),
	CONSTRAINT "ck_betman_history_match_result" CHECK("betman_history_matches"."result" is null or "betman_history_matches"."result" in ('H', 'D', 'A')),
	CONSTRAINT "ck_betman_history_match_status" CHECK("betman_history_matches"."display_status" in ('INCLUDED', 'CANCELLED', 'PENDING_RESULT', 'MISSING_ODDS', 'TEAM_MATCH_FAILED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_betman_history_match_source` ON `betman_history_matches` (`gm_id`,`gm_ts`,`match_seq`);--> statement-breakpoint
CREATE INDEX `idx_betman_history_matches_status_date` ON `betman_history_matches` (`display_status`,"match_date" desc,"kickoff_at" desc);--> statement-breakpoint
CREATE INDEX `idx_betman_history_matches_league_date` ON `betman_history_matches` (`league_code`,"match_date" desc,"kickoff_at" desc);--> statement-breakpoint
CREATE INDEX `idx_betman_history_matches_home_date` ON `betman_history_matches` (`league_code`,`home_team_id`,"match_date" desc);--> statement-breakpoint
CREATE INDEX `idx_betman_history_matches_away_date` ON `betman_history_matches` (`league_code`,`away_team_id`,"match_date" desc);--> statement-breakpoint
CREATE INDEX `idx_betman_history_matches_round` ON `betman_history_matches` (`round_key`);--> statement-breakpoint
CREATE TABLE `betman_history_rounds` (
	`round_key` text PRIMARY KEY NOT NULL,
	`gm_id` text NOT NULL,
	`gm_ts` text NOT NULL,
	`source_url` text NOT NULL,
	`status` text NOT NULL,
	`provider_final` integer DEFAULT 0 NOT NULL,
	`event_from` text,
	`event_to` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` text,
	`last_success_at` text,
	`finalized_at` text,
	`error_code` text,
	`error_message` text,
	`lease_expires_at` text,
	`lease_token` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "ck_betman_history_round_gm" CHECK("betman_history_rounds"."gm_id" = 'G101')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_betman_history_round` ON `betman_history_rounds` (`gm_id`,`gm_ts`);--> statement-breakpoint
CREATE INDEX `idx_betman_history_rounds_status_range` ON `betman_history_rounds` (`status`,`event_from`,`event_to`);
