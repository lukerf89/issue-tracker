import Link from "next/link";

export default function IssueNotFound() {
  return (
    <section className="rounded-md border border-zinc-800 bg-zinc-950 p-5">
      <h1 className="text-lg font-semibold text-zinc-100">Issue not found</h1>
      <p className="mt-2 text-sm text-zinc-400">
        The requested issue identifier does not exist in this tracker database.
      </p>
      <Link
        className="mt-4 inline-flex h-9 items-center rounded border border-zinc-700 px-3 text-sm font-medium text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50"
        href="/"
      >
        Back to issues
      </Link>
    </section>
  );
}
