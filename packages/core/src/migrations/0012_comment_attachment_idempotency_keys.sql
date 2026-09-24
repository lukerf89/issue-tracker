ALTER TABLE `attachments` ADD `idempotency_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_idempotency_key_unique` ON `attachments` (`idempotency_key`) WHERE "attachments"."idempotency_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `comments` ADD `idempotency_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `comments_idempotency_key_unique` ON `comments` (`idempotency_key`) WHERE "comments"."idempotency_key" IS NOT NULL;