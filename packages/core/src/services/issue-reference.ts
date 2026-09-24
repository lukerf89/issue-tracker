import type { Issue } from "../db/schema.js";

export interface IssueReference {
  id: string;
  identifier: string;
  teamId: string;
  number: number;
  title: string;
}

export type IssueReferenceSource = Pick<Issue, "id" | "identifier" | "teamId" | "number" | "title">;

export function issueReference(issue: IssueReferenceSource): IssueReference {
  return {
    id: issue.id,
    identifier: issue.identifier,
    teamId: issue.teamId,
    number: issue.number,
    title: issue.title
  };
}
