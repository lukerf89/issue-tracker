CREATE TABLE `engine_health` (
	`engine_name` text NOT NULL,
	`fingerprint` text NOT NULL,
	`installed` integer NOT NULL,
	`authenticated` integer NOT NULL,
	`model_accessible` integer NOT NULL,
	`diagnostic_code` text,
	`remediation` text,
	`checked_at` text NOT NULL,
	PRIMARY KEY(`engine_name`, `fingerprint`)
);
--> statement-breakpoint
CREATE INDEX `engine_health_checked_idx` ON `engine_health` (`checked_at`);