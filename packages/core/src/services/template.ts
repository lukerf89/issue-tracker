import { asc, eq } from "drizzle-orm";

import { inTransaction, type ServiceContext } from "../context.js";
import { templates, type Template } from "../db/schema.js";
import { AppError, AppErrorCode } from "../errors.js";
import { uuid } from "../ids.js";
import { createIssueInputSchema } from "../schemas/issue.js";
import {
  createIssueFromTemplateOverridesSchema,
  createTemplateInputSchema,
  templateLabelsSchema
} from "../schemas/template.js";
import { createIssue, type CreateIssueInput, type IssueWithDetails } from "./issue.js";

export interface CreateTemplateInput {
  name: string;
  title?: string | null;
  description?: string | null;
  priority?: number | null;
  team?: string | null;
  project?: string | null;
  labels?: string[];
}

export interface DeleteTemplateInput {
  name: string;
}

export type CreateIssueFromTemplateOverrides = Partial<CreateIssueInput>;

export interface CreateIssueFromTemplateInput {
  name: string;
  overrides?: CreateIssueFromTemplateOverrides;
}

export type TemplateWithLabels = Omit<Template, "labels"> & {
  labels: string[];
};

export function createTemplate(
  context: ServiceContext,
  input: CreateTemplateInput
): TemplateWithLabels {
  const parsed = createTemplateInputSchema.parse(input);

  return inTransaction(context, (txContext) => {
    const existing = findTemplateByName(txContext, parsed.name);

    if (existing) {
      throw new AppError(
        AppErrorCode.TEMPLATE_NAME_TAKEN,
        `Template ${parsed.name} already exists.`,
        { name: parsed.name }
      );
    }

    const now = txContext.clock.now().toISOString();
    const row = {
      id: uuid(),
      name: parsed.name,
      title: parsed.title ?? null,
      description: parsed.description ?? null,
      priority: parsed.priority ?? null,
      team: parsed.team ?? null,
      project: parsed.project ?? null,
      labels: parsed.labels ?? [],
      createdAt: now,
      updatedAt: now
    };

    txContext.db.insert(templates).values(row).run();
    return getTemplateByName(txContext, row.name);
  });
}

export function listTemplates(context: ServiceContext): TemplateWithLabels[] {
  return context.db.query.templates.findMany({
    orderBy: [asc(templates.name), asc(templates.id)]
  }).sync().map(templateWithParsedLabels);
}

export function deleteTemplate(
  context: ServiceContext,
  name: string
): TemplateWithLabels {
  return inTransaction(context, (txContext) => {
    const template = getTemplateByName(txContext, name);

    txContext.db.delete(templates).where(eq(templates.id, template.id)).run();
    return template;
  });
}

export function createIssueFromTemplate(
  context: ServiceContext,
  name: string,
  overrides: CreateIssueFromTemplateOverrides = {}
): IssueWithDetails {
  const template = getTemplateByName(context, name);
  const parsedOverrides = omitUndefined(createIssueFromTemplateOverridesSchema.parse(overrides));
  const input: Partial<CreateIssueInput> = { ...parsedOverrides };

  applyTemplateField(input, "title", template.title);
  applyTemplateField(input, "description", template.description);
  applyTemplateField(input, "priority", template.priority);
  applyTemplateField(input, "team", template.team);
  applyTemplateField(input, "project", template.project);

  if (!hasOwn(input, "labels") && template.labels.length > 0) {
    input.labels = template.labels;
  }

  return createIssue(context, createIssueInputSchema.parse(input));
}

function getTemplateByName(context: ServiceContext, name: string): TemplateWithLabels {
  const template = findTemplateByName(context, name);

  return template ? templateWithParsedLabels(template) : notFound(name);
}

function findTemplateByName(
  context: ServiceContext,
  name: string
): Template | undefined {
  return context.db.query.templates.findFirst({
    where: eq(templates.name, name)
  }).sync();
}

function templateWithParsedLabels(template: Template): TemplateWithLabels {
  return {
    ...template,
    labels: parseStoredLabels(template.labels)
  };
}

function parseStoredLabels(labels: unknown): string[] {
  const parsed = typeof labels === "string" ? JSON.parse(labels) as unknown : labels;
  return templateLabelsSchema.parse(parsed);
}

function applyTemplateField<K extends keyof CreateIssueInput>(
  input: Partial<CreateIssueInput>,
  key: K,
  value: CreateIssueInput[K] | null
): void {
  if (!hasOwn(input, key) && value !== null) {
    input[key] = value;
  }
}

function omitUndefined<T extends Record<string, unknown>>(object: T): T {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined)
  ) as T;
}

function hasOwn<T extends object>(object: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function notFound(name: string): never {
  throw new AppError(
    AppErrorCode.TEMPLATE_NOT_FOUND,
    `Template ${name} was not found.`,
    { template: name }
  );
}
