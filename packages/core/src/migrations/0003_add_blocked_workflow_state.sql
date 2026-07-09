CREATE TEMP TABLE `__blocked_state_backfill` AS
SELECT
  `teams`.`id` AS `team_id`,
  COALESCE(
    (
      SELECT min(`workflow_states`.`position`)
      FROM `workflow_states`
      WHERE
        `workflow_states`.`team_id` = `teams`.`id`
        AND `workflow_states`.`type` IN ('completed', 'canceled')
    ),
    (
      SELECT max(`workflow_states`.`position`) + 1
      FROM `workflow_states`
      WHERE `workflow_states`.`team_id` = `teams`.`id`
    ),
    3
  ) AS `position`
FROM `teams`
WHERE NOT EXISTS (
  SELECT 1
  FROM `workflow_states`
  WHERE
    `workflow_states`.`team_id` = `teams`.`id`
    AND `workflow_states`.`name` = 'Blocked'
);
--> statement-breakpoint
UPDATE `workflow_states`
SET `position` = `position` + 1
WHERE
  `team_id` IN (SELECT `team_id` FROM `__blocked_state_backfill`)
  AND `position` >= (
    SELECT `position`
    FROM `__blocked_state_backfill`
    WHERE `__blocked_state_backfill`.`team_id` = `workflow_states`.`team_id`
  );
--> statement-breakpoint
INSERT INTO `workflow_states` (`id`, `team_id`, `name`, `type`, `color`, `position`)
SELECT
  lower(
    hex(randomblob(4)) || '-' ||
    hex(randomblob(2)) || '-' ||
    hex(randomblob(2)) || '-' ||
    hex(randomblob(2)) || '-' ||
    hex(randomblob(6))
  ),
  `team_id`,
  'Blocked',
  'blocked',
  '#F59E0B',
  `position`
FROM `__blocked_state_backfill`;
--> statement-breakpoint
DROP TABLE `__blocked_state_backfill`;
