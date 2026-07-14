CREATE TABLE `issue_dependencies` (
	`blocking_issue_id` text NOT NULL,
	`blocked_issue_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`blocking_issue_id`, `blocked_issue_id`),
	FOREIGN KEY (`blocking_issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`blocked_issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE no action
);
