CREATE TABLE `issue_relations` (
	`kind` text NOT NULL,
	`source_issue_id` text NOT NULL,
	`target_issue_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`kind`, `source_issue_id`, `target_issue_id`),
	FOREIGN KEY (`source_issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "issue_relations_kind_check" CHECK("issue_relations"."kind" IN ('related', 'follow_up')),
	CONSTRAINT "issue_relations_not_self_check" CHECK("issue_relations"."source_issue_id" <> "issue_relations"."target_issue_id"),
	CONSTRAINT "issue_relations_related_order_check" CHECK("issue_relations"."kind" <> 'related' OR "issue_relations"."source_issue_id" < "issue_relations"."target_issue_id")
);
--> statement-breakpoint
CREATE INDEX `issue_relations_target_idx` ON `issue_relations` (`target_issue_id`,`kind`);
--> statement-breakpoint
CREATE TRIGGER issue_relations_insert_revision AFTER INSERT ON issue_relations BEGIN UPDATE issues SET revision = revision + 1 WHERE id IN (NEW.source_issue_id, NEW.target_issue_id); END;
--> statement-breakpoint
CREATE TRIGGER issue_relations_delete_revision AFTER DELETE ON issue_relations BEGIN UPDATE issues SET revision = revision + 1 WHERE id IN (OLD.source_issue_id, OLD.target_issue_id); END;
