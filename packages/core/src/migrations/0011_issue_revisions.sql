ALTER TABLE issues ADD COLUMN revision integer NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE TRIGGER issue_scalar_revision AFTER UPDATE ON issues WHEN NEW.title IS NOT OLD.title OR NEW.description IS NOT OLD.description OR NEW.state_id IS NOT OLD.state_id OR NEW.priority IS NOT OLD.priority OR NEW.assignee_id IS NOT OLD.assignee_id OR NEW.project_id IS NOT OLD.project_id OR NEW.cycle_id IS NOT OLD.cycle_id OR NEW.parent_id IS NOT OLD.parent_id OR NEW.estimate IS NOT OLD.estimate OR NEW.due_date IS NOT OLD.due_date OR NEW.sort_order IS NOT OLD.sort_order OR NEW.archived_at IS NOT OLD.archived_at OR NEW.started_at IS NOT OLD.started_at OR NEW.completed_at IS NOT OLD.completed_at OR NEW.canceled_at IS NOT OLD.canceled_at BEGIN UPDATE issues SET revision = revision + 1 WHERE id = NEW.id; END;
--> statement-breakpoint
CREATE TRIGGER comments_insert_revision AFTER INSERT ON comments BEGIN UPDATE issues SET revision = revision + 1 WHERE id = NEW.issue_id; END;
--> statement-breakpoint
CREATE TRIGGER comments_delete_revision AFTER DELETE ON comments BEGIN UPDATE issues SET revision = revision + 1 WHERE id = OLD.issue_id; END;
--> statement-breakpoint
CREATE TRIGGER comments_update_revision AFTER UPDATE ON comments BEGIN UPDATE issues SET revision = revision + 1 WHERE id = NEW.issue_id; END;
--> statement-breakpoint
CREATE TRIGGER attachments_insert_revision AFTER INSERT ON attachments BEGIN UPDATE issues SET revision = revision + 1 WHERE id = NEW.issue_id; END;
--> statement-breakpoint
CREATE TRIGGER attachments_delete_revision AFTER DELETE ON attachments BEGIN UPDATE issues SET revision = revision + 1 WHERE id = OLD.issue_id; END;
--> statement-breakpoint
CREATE TRIGGER attachments_update_revision AFTER UPDATE ON attachments BEGIN UPDATE issues SET revision = revision + 1 WHERE id = NEW.issue_id; END;
--> statement-breakpoint
CREATE TRIGGER issue_labels_insert_revision AFTER INSERT ON issue_labels BEGIN UPDATE issues SET revision = revision + 1 WHERE id = NEW.issue_id; END;
--> statement-breakpoint
CREATE TRIGGER issue_labels_delete_revision AFTER DELETE ON issue_labels BEGIN UPDATE issues SET revision = revision + 1 WHERE id = OLD.issue_id; END;
--> statement-breakpoint
CREATE TRIGGER issue_labels_update_revision AFTER UPDATE ON issue_labels BEGIN UPDATE issues SET revision = revision + 1 WHERE id = NEW.issue_id; END;
--> statement-breakpoint
CREATE TRIGGER dependency_insert_revision AFTER INSERT ON issue_dependencies BEGIN UPDATE issues SET revision = revision + 1 WHERE id IN (NEW.blocking_issue_id, NEW.blocked_issue_id); END;
--> statement-breakpoint
CREATE TRIGGER dependency_delete_revision AFTER DELETE ON issue_dependencies BEGIN UPDATE issues SET revision = revision + 1 WHERE id IN (OLD.blocking_issue_id, OLD.blocked_issue_id); END;
