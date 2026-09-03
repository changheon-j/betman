ALTER TABLE `market_predictions` ADD `selected_option_index` integer CHECK (`selected_option_index` IS NULL OR `selected_option_index` BETWEEN 0 AND 2);
