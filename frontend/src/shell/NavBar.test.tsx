import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { NavBar } from "./NavBar";

describe("NavBar", () => {
  it("marks the active page and its group", () => {
    render(<NavBar active="settings" />);
    expect(screen.getByRole("link", { name: /Settings/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: /Admin/ })).toHaveClass("active");
    expect(screen.getByRole("button", { name: /Tag/ })).not.toHaveClass("active");
  });

  it("opens one dropdown at a time and closes on Escape", async () => {
    const user = userEvent.setup();
    render(<NavBar active="home" />);
    const tag = screen.getByRole("button", { name: /Tag/ });
    const admin = screen.getByRole("button", { name: /Admin/ });

    await user.click(tag);
    expect(tag).toHaveAttribute("aria-expanded", "true");

    await user.click(admin);
    expect(admin).toHaveAttribute("aria-expanded", "true");
    expect(tag).toHaveAttribute("aria-expanded", "false");

    await user.keyboard("{Escape}");
    expect(admin).toHaveAttribute("aria-expanded", "false");
  });

  it("closes on a click outside the nav", async () => {
    const user = userEvent.setup();
    render(<><NavBar active="home" /><p>outside</p></>);
    const tag = screen.getByRole("button", { name: /Tag/ });
    await user.click(tag);
    await user.click(screen.getByText("outside"));
    expect(tag).toHaveAttribute("aria-expanded", "false");
  });
});
