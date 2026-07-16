-- Full-text search index over issues (title + description + identifier).
-- Standalone FTS5 table keyed to issues.id via an UNINDEXED issue_id column
-- (issues.id is a text UUID, not an integer rowid). Kept in sync with triggers.
CREATE VIRTUAL TABLE `issues_fts` USING fts5(
  `identifier`,
  `title`,
  `description`,
  `issue_id` UNINDEXED,
  tokenize = 'porter unicode61'
);
--> statement-breakpoint
INSERT INTO `issues_fts` (`identifier`, `title`, `description`, `issue_id`)
SELECT `identifier`, `title`, coalesce(`description`, ''), `id` FROM `issues`;
--> statement-breakpoint
CREATE TRIGGER `issues_fts_after_insert` AFTER INSERT ON `issues` BEGIN
  INSERT INTO `issues_fts` (`identifier`, `title`, `description`, `issue_id`)
  VALUES (new.`identifier`, new.`title`, coalesce(new.`description`, ''), new.`id`);
END;
--> statement-breakpoint
CREATE TRIGGER `issues_fts_after_delete` AFTER DELETE ON `issues` BEGIN
  DELETE FROM `issues_fts` WHERE `issue_id` = old.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `issues_fts_after_update` AFTER UPDATE ON `issues` BEGIN
  DELETE FROM `issues_fts` WHERE `issue_id` = old.`id`;
  INSERT INTO `issues_fts` (`identifier`, `title`, `description`, `issue_id`)
  VALUES (new.`identifier`, new.`title`, coalesce(new.`description`, ''), new.`id`);
END;
