CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`profile_id` text,
	`workflow` text NOT NULL,
	`workflow_version` integer NOT NULL,
	`schema_version` integer NOT NULL,
	`resolved_configuration` text NOT NULL,
	`phase` text NOT NULL,
	`state` text NOT NULL,
	`primary_repository_id` text NOT NULL,
	`base_ref` text NOT NULL,
	`base_commit` text NOT NULL,
	`branch` text NOT NULL,
	`worktree_path` text NOT NULL,
	`parallel_group` text,
	`event_counter` integer DEFAULT 0 NOT NULL,
	`attempt_counter` integer DEFAULT 0 NOT NULL,
	`started_at` text,
	`last_event_at` text NOT NULL,
	`last_progress_at` text NOT NULL,
	`completed_at` text,
	`outcome` text,
	`error` text,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`) REFERENCES `orchestration_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`primary_repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_runs_terminal_timestamp" CHECK(("agent_runs"."state" IN ('succeeded','partial','failed','canceled','crashed') AND "agent_runs"."completed_at" IS NOT NULL) OR ("agent_runs"."state" NOT IN ('succeeded','partial','failed','canceled','crashed') AND "agent_runs"."completed_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_runs_one_active_per_issue` ON `agent_runs` (`issue_id`) WHERE "agent_runs"."completed_at" IS NULL AND "agent_runs"."parallel_group" IS NULL;--> statement-breakpoint
CREATE INDEX `agent_runs_state_created_idx` ON `agent_runs` (`state`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_runs_worktree_unique` ON `agent_runs` (`worktree_path`);--> statement-breakpoint
CREATE TABLE `issue_repositories` (
	`issue_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`position` integer NOT NULL,
	`override_kind` text DEFAULT 'replace' NOT NULL,
	PRIMARY KEY(`issue_id`, `repository_id`),
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_repositories_position_unique` ON `issue_repositories` (`issue_id`,`position`);--> statement-breakpoint
CREATE TABLE `orchestration_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`workflow` text NOT NULL,
	`schema_version` integer NOT NULL,
	`configuration` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`is_builtin` integer DEFAULT false NOT NULL,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orchestration_profiles_name_unique` ON `orchestration_profiles` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `orchestration_profiles_one_default` ON `orchestration_profiles` (`is_default`) WHERE "orchestration_profiles"."is_default" = 1 AND "orchestration_profiles"."archived_at" IS NULL;--> statement-breakpoint
INSERT INTO `orchestration_profiles` (`id`, `name`, `workflow`, `schema_version`, `configuration`, `is_default`, `is_builtin`, `archived_at`, `created_at`, `updated_at`) SELECT 'builtin-issue-delivery', 'issue-delivery', 'issue-delivery', 1, '{"roles":{"orchestrator":"claude-default","planner":"claude-default","implementer":"claude-default","verifier":"claude-default","bindingReviewer":"claude-default","adversarialReviewer":"claude-default"},"reviewDepth":"auto","isolation":"worktree","permissionPolicy":"prompt","fallbackPolicy":"explicit","pushPolicy":"approved","draftPrPolicy":"approved","mergePolicy":"human","maxAddressCycles":2,"stallThresholdMs":300000,"issueStartedState":"__started__","issueReviewState":null}', 1, 1, NULL, '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z' WHERE EXISTS (SELECT 1 FROM `teams`);--> statement-breakpoint
CREATE TABLE `project_repositories` (
	`project_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`position` integer NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`project_id`, `repository_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_repositories_one_default` ON `project_repositories` (`project_id`) WHERE "project_repositories"."is_default" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `project_repositories_position_unique` ON `project_repositories` (`project_id`,`position`);--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`canonical_path` text NOT NULL,
	`common_dir` text NOT NULL,
	`default_branch` text NOT NULL,
	`remote` text,
	`setup_command` text,
	`test_command` text NOT NULL,
	`verification_command` text NOT NULL,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_name_unique` ON `repositories` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_canonical_path_unique` ON `repositories` (`canonical_path`);--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_common_dir_unique` ON `repositories` (`common_dir`);--> statement-breakpoint
CREATE TABLE `run_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`attempt_id` text,
	`kind` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`payload` text NOT NULL,
	`state` text NOT NULL,
	`lease_owner` text,
	`lease_expires_at` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`result` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `run_attempts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_actions_idempotency_unique` ON `run_actions` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `run_actions_claim_idx` ON `run_actions` (`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `run_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`attempt_id` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`local_path` text,
	`url` text,
	`sha256` text,
	`metadata` text NOT NULL,
	`attachment_id` text,
	`removed_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `run_attempts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attachment_id`) REFERENCES `attachments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `run_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`number` integer NOT NULL,
	`reason` text NOT NULL,
	`requested_engine` text NOT NULL,
	`actual_engine` text,
	`state` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	`result` text,
	`error` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_attempts_one_active` ON `run_attempts` (`run_id`) WHERE "run_attempts"."completed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `run_attempts_number_unique` ON `run_attempts` (`run_id`,`number`);--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`attempt_id` text,
	`participant_id` text,
	`type` text NOT NULL,
	`schema_version` integer NOT NULL,
	`data` text NOT NULL,
	`provider_event_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `run_attempts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`participant_id`) REFERENCES `run_participants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_events_provider_unique` ON `run_events` (`participant_id`,`provider_event_id`) WHERE "run_events"."provider_event_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `run_events_sequence_unique` ON `run_events` (`run_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `run_input_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`kind` text NOT NULL,
	`prompt` text NOT NULL,
	`operation` text,
	`blocking` integer NOT NULL,
	`state` text NOT NULL,
	`response` text,
	`requested_by` text NOT NULL,
	`responded_by` text,
	`requested_at` text NOT NULL,
	`responded_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`participant_id`) REFERENCES `run_participants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `run_participants` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`actor` text NOT NULL,
	`role` text NOT NULL,
	`adapter` text NOT NULL,
	`requested_model` text NOT NULL,
	`actual_model` text,
	`provider_session_id` text,
	`capabilities` text NOT NULL,
	`process_identity` text,
	`state` text NOT NULL,
	`started_at` text,
	`last_heartbeat_at` text,
	`completed_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `run_attempts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `run_repositories` (
	`run_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`position` integer NOT NULL,
	`base_ref` text NOT NULL,
	`base_commit` text NOT NULL,
	`worktree_path` text NOT NULL,
	`branch` text NOT NULL,
	`is_primary` integer NOT NULL,
	PRIMARY KEY(`run_id`, `repository_id`),
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_repositories_path_unique` ON `run_repositories` (`worktree_path`);--> statement-breakpoint
CREATE TABLE `run_review_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`severity` text NOT NULL,
	`source` text NOT NULL,
	`file` text,
	`location` text,
	`summary` text NOT NULL,
	`evidence` text NOT NULL,
	`resolution` text,
	`reconciliation` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`participant_id`) REFERENCES `run_participants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_review_findings_fingerprint_unique` ON `run_review_findings` (`run_id`,`participant_id`,`fingerprint`);--> statement-breakpoint
CREATE TABLE `run_verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`commit_sha` text NOT NULL,
	`command` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text NOT NULL,
	`exit_code` integer,
	`classification` text NOT NULL,
	`log_artifact_id` text,
	`summary` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `run_attempts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`log_artifact_id`) REFERENCES `run_artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `supervisor_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`process_identity` text NOT NULL,
	`version` text NOT NULL,
	`capabilities` text NOT NULL,
	`started_at` text NOT NULL,
	`last_heartbeat_at` text NOT NULL
);
