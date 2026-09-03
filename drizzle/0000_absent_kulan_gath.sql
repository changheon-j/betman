CREATE TABLE `market_predictions` (
	`prediction_key` text PRIMARY KEY NOT NULL,
	`match_id` integer NOT NULL,
	`match_date` text NOT NULL,
	`kickoff_time` text NOT NULL,
	`home_team` text NOT NULL,
	`away_team` text NOT NULL,
	`market_index` integer NOT NULL,
	`market_type` text NOT NULL,
	`market_condition` text NOT NULL,
	`options_json` text NOT NULL,
	`probability_sum` real NOT NULL,
	`saved_at` text NOT NULL
);
