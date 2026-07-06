import { Fragment, createElement, type ReactNode } from "react";

interface MarkdownProps {
  source: string | null;
  emptyLabel?: string;
}

export function Markdown({ source, emptyLabel = "No content." }: MarkdownProps) {
  const trimmed = source?.trim();

  if (!trimmed) {
    return <p className="text-sm text-zinc-500">{emptyLabel}</p>;
  }

  return <div className="space-y-3 text-sm leading-6 text-zinc-300">{renderBlocks(trimmed)}</div>;
}

function renderBlocks(source: string): ReactNode[] {
  const lines = source.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 4);
      blocks.push(
        createElement(
          `h${level}`,
          { className: "font-semibold text-zinc-100", key: `heading-${index}` },
          renderInline(heading[2])
        )
      );
      index += 1;
      continue;
    }

    if (/^\s*-\s+/.test(line)) {
      const items: string[] = [];

      while (index < lines.length && /^\s*-\s+/.test(lines[index] ?? "")) {
        items.push((lines[index] ?? "").replace(/^\s*-\s+/, ""));
        index += 1;
      }

      blocks.push(
        <ul className="list-disc space-y-1 pl-5" key={`list-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={`${item}-${itemIndex}`}>{renderInline(item)}</li>
          ))}
        </ul>
      );
      continue;
    }

    const paragraph: string[] = [];

    while (
      index < lines.length &&
      (lines[index] ?? "").trim().length > 0 &&
      !/^(#{1,4})\s+/.test(lines[index] ?? "") &&
      !/^\s*-\s+/.test(lines[index] ?? "")
    ) {
      paragraph.push((lines[index] ?? "").trim());
      index += 1;
    }

    blocks.push(
      <p className="whitespace-pre-wrap" key={`paragraph-${index}`}>
        {renderInline(paragraph.join(" "))}
      </p>
    );
  }

  return blocks;
}

function renderInline(source: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(source.slice(lastIndex, match.index));
    }

    const token = match[0];
    const key = `${token}-${match.index}`;

    if (token.startsWith("**")) {
      nodes.push(
        <strong className="font-semibold text-zinc-100" key={key}>
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith("`")) {
      nodes.push(
        <code className="rounded bg-zinc-900 px-1 py-0.5 text-xs text-zinc-100" key={key}>
          {token.slice(1, -1)}
        </code>
      );
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      const href = link ? safeHref(link[2]) : "#";

      nodes.push(
        <a
          className="text-sky-300 underline decoration-sky-800 underline-offset-2 hover:text-sky-200"
          href={href}
          key={key}
          rel="noreferrer"
          target={href.startsWith("http") ? "_blank" : undefined}
        >
          {link?.[1] ?? token}
        </a>
      );
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < source.length) {
    nodes.push(source.slice(lastIndex));
  }

  return nodes.map((node, index) => <Fragment key={index}>{node}</Fragment>);
}

function safeHref(href: string): string {
  return /^(https?:\/\/|\/)/.test(href) ? href : "#";
}
