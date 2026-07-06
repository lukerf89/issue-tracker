import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

describe("web test setup", () => {
  it("renders with React Testing Library in jsdom", () => {
    render(createElement("a", { href: "/board" }, "Board"));

    expect(screen.getByRole("link", { name: "Board" })).toHaveAttribute("href", "/board");
  });
});
