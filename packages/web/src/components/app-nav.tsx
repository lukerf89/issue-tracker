import Link from "next/link";

export function AppNav() {
  return (
    <header className="border-b border-zinc-800 bg-zinc-950/95">
      <nav
        aria-label="Primary"
        className="mx-auto flex h-12 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8"
      >
        <Link className="text-sm font-semibold text-zinc-100" href="/">
          Issue Tracker
        </Link>
        <div className="flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 p-1">
          <Link
            className="rounded px-3 py-1.5 text-sm font-medium text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50"
            href="/"
          >
            List
          </Link>
          <Link
            className="rounded px-3 py-1.5 text-sm font-medium text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50"
            href="/board"
          >
            Board
          </Link>
        </div>
      </nav>
    </header>
  );
}
