INSERT INTO workflow_states (id, team_id, name, type, color, position)
SELECT lower(hex(randomblob(16))), id, 'Ready for Review', 'started', '#8B5CF6', 2.5
FROM teams WHERE NOT EXISTS (
  SELECT 1 FROM workflow_states WHERE team_id = teams.id AND name = 'Ready for Review'
);
--> statement-breakpoint
CREATE TABLE issue_criteria (
  id text PRIMARY KEY NOT NULL,
  issue_id text NOT NULL REFERENCES issues(id),
  text text NOT NULL,
  status text NOT NULL CONSTRAINT issue_criteria_status_check CHECK (status IN ('pending', 'passed', 'failed', 'waived')),
  evidence_url text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  archived_at text
);
--> statement-breakpoint
CREATE INDEX issue_criteria_issue_idx ON issue_criteria(issue_id);
--> statement-breakpoint
CREATE TABLE issue_blockers (
  id text PRIMARY KEY NOT NULL,
  issue_id text NOT NULL REFERENCES issues(id),
  kind text NOT NULL CONSTRAINT issue_blockers_kind_check CHECK (kind IN ('network', 'dependency', 'human_review', 'evaluation_data', 'other')),
  description text NOT NULL,
  unblock_action text NOT NULL,
  owner text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  resolved_at text
);
--> statement-breakpoint
CREATE INDEX issue_blockers_issue_idx ON issue_blockers(issue_id);
--> statement-breakpoint
CREATE TRIGGER issue_criteria_insert_revision AFTER INSERT ON issue_criteria BEGIN UPDATE issues SET revision = revision + 1 WHERE id = NEW.issue_id; END;
--> statement-breakpoint
CREATE TRIGGER issue_criteria_update_revision AFTER UPDATE ON issue_criteria BEGIN UPDATE issues SET revision = revision + 1 WHERE id = NEW.issue_id; END;
--> statement-breakpoint
CREATE TRIGGER issue_blockers_insert_revision AFTER INSERT ON issue_blockers BEGIN UPDATE issues SET revision = revision + 1 WHERE id = NEW.issue_id; END;
--> statement-breakpoint
CREATE TRIGGER issue_blockers_update_revision AFTER UPDATE ON issue_blockers BEGIN UPDATE issues SET revision = revision + 1 WHERE id = NEW.issue_id; END;
