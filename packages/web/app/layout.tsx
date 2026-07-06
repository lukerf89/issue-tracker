import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AppNav } from "../src/components/app-nav";

import "./globals.css";

export const metadata: Metadata = {
  title: "Issue Tracker",
  description: "Local issue tracker web UI"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="min-h-dvh bg-zinc-950 text-zinc-100">
          <AppNav />
          <main className="mx-auto max-w-7xl px-4 py-5 sm:px-6 lg:px-8">{children}</main>
        </div>
      </body>
    </html>
  );
}
