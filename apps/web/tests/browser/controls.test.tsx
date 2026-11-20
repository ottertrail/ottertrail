import type * as React from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import "../../src/styles/globals.css";
import { Button } from "../../src/components/ui/button.tsx";
import { Checkbox } from "../../src/components/ui/checkbox.tsx";
import { Switch } from "../../src/components/ui/switch.tsx";
import { Tabs, TabsList, TabsTrigger } from "../../src/components/ui/tabs.tsx";
import { ToggleGroup, ToggleGroupItem } from "../../src/components/ui/toggle-group.tsx";
import { applyTheme } from "../../src/lib/theme.ts";
import { trackMounted } from "./mounted.ts";

/*
 * The base rule that gives every enabled clickable control the pointer
 * (globals.css), and the chosen item of a toggle group, which must stand
 * out from the others by at least 3:1 (WCAG 1.4.11; docs/design-system.md).
 */

function mount(node: React.ReactNode) {
  document.documentElement.classList.add("dark");
  const container = document.createElement("div");
  container.className = "bg-background p-4";
  document.body.append(container);
  const root = createRoot(container);
  root.render(node);
  trackMounted(() => {
    root.unmount();
    container.remove();
  });
  return container;
}

const cursorOf = (element: Element) => getComputedStyle(element).cursor;

/** An `rgb()` or `rgba()` computed colour as its channels and alpha. */
function rgba(color: string): [number, number, number, number] {
  const parts = /rgba?\(([^)]+)\)/
    .exec(color)?.[1]
    ?.split(/[ ,/]+/)
    .filter(Boolean);
  if (parts === undefined || parts.length < 3) throw new Error(`Not an rgb colour: ${color}`);
  const [r, g, b, a = "1"] = parts;
  return [Number(r), Number(g), Number(b), Number(a)];
}

/** `color` composited over the opaque `under`, as it shows. */
function over(color: string, under: string): [number, number, number] {
  const [r, g, b, a] = rgba(color);
  const [ur, ug, ub] = rgba(under);
  return [r * a + ur * (1 - a), g * a + ug * (1 - a), b * a + ub * (1 - a)];
}

function linear(channel: number): number {
  const srgb = channel / 255;
  return srgb <= 0.040_45 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe("the pointer on clickable controls", () => {
  test("an enabled button, toggle item, tab, switch and checkbox show the pointer; a disabled button does not", async () => {
    mount(
      <div>
        <Button>Save</Button>
        <Button disabled>Saving</Button>
        <ToggleGroup defaultValue={["a"]} aria-label="Which">
          <ToggleGroupItem value="a">A</ToggleGroupItem>
          <ToggleGroupItem value="b">B</ToggleGroupItem>
          <ToggleGroupItem value="c" disabled>
            C
          </ToggleGroupItem>
        </ToggleGroup>
        <Tabs defaultValue="one">
          <TabsList>
            <TabsTrigger value="one">One</TabsTrigger>
            <TabsTrigger value="two">Two</TabsTrigger>
          </TabsList>
        </Tabs>
        <Switch aria-label="On" />
        <Checkbox aria-label="Keep" />
      </div>,
    );
    await expect.element(page.getByRole("button", { name: "Save" })).toBeVisible();

    expect(cursorOf(page.getByRole("button", { name: "Save" }).element())).toBe("pointer");
    expect(cursorOf(page.getByRole("button", { name: "A" }).element())).toBe("pointer");
    expect(cursorOf(page.getByRole("button", { name: "B" }).element())).toBe("pointer");
    expect(cursorOf(page.getByRole("tab", { name: "Two" }).element())).toBe("pointer");
    expect(cursorOf(page.getByRole("switch", { name: "On" }).element())).toBe("pointer");
    expect(cursorOf(page.getByRole("checkbox", { name: "Keep" }).element())).toBe("pointer");

    expect(cursorOf(page.getByRole("button", { name: "Saving" }).element())).not.toBe("pointer");
    expect(cursorOf(page.getByRole("button", { name: "C" }).element())).not.toBe("pointer");
  });
});

describe("a toggle group's chosen item", () => {
  test("in the light theme is a dark fill with white text, far from the unchosen items", async () => {
    try {
      const container = mount(
        <ToggleGroup
          defaultValue={["unresolved"]}
          aria-label="Status"
          variant="outline"
          spacing={0}
        >
          <ToggleGroupItem value="unresolved" className="transition-none">
            Unresolved
          </ToggleGroupItem>
          <ToggleGroupItem value="resolved" className="transition-none">
            Resolved
          </ToggleGroupItem>
        </ToggleGroup>,
      );
      // mount() sets the dark theme: switch to light once mounted.
      applyTheme("light");
      const chosen = page.getByRole("button", { name: "Unresolved" });
      const other = page.getByRole("button", { name: "Resolved" });
      await expect.element(chosen).toHaveAttribute("aria-pressed", "true");
      const surface = getComputedStyle(container).backgroundColor;
      const fill = over(getComputedStyle(chosen.element()).backgroundColor, surface);
      // The light toggle-on token, #4a444a, with white text on it.
      expect(fill).toEqual([74, 68, 74]);
      expect(over(getComputedStyle(chosen.element()).color, surface)).toEqual([255, 255, 255]);
      const rest = over(getComputedStyle(other.element()).backgroundColor, surface);
      expect(contrast(fill, rest)).toBeGreaterThanOrEqual(7);
    } finally {
      applyTheme("dark");
    }
  });

  test("is filled, in ink, at least 3:1 from the unchosen items at rest and hovered, and keeps aria-pressed", async () => {
    const container = mount(
      <ToggleGroup defaultValue={["unresolved"]} aria-label="Status" variant="outline" spacing={0}>
        {/* No colour fade, so each colour is read where it settles, not halfway. */}
        <ToggleGroupItem value="unresolved" className="transition-none">
          Unresolved
        </ToggleGroupItem>
        <ToggleGroupItem value="resolved" className="transition-none">
          Resolved
        </ToggleGroupItem>
        <ToggleGroupItem value="all" className="transition-none">
          All
        </ToggleGroupItem>
      </ToggleGroup>,
    );
    const chosen = page.getByRole("button", { name: "Unresolved" });
    const other = page.getByRole("button", { name: "Resolved" });
    await expect.element(chosen).toHaveAttribute("aria-pressed", "true");
    await expect.element(other).toHaveAttribute("aria-pressed", "false");

    const surface = getComputedStyle(container).backgroundColor;
    expect(getComputedStyle(chosen.element()).transitionDuration).toBe("0s");
    const fill = over(getComputedStyle(chosen.element()).backgroundColor, surface);
    // The toggle-on token, #746f75.
    expect(fill).toEqual([116, 111, 117]);
    const rest = over(getComputedStyle(other.element()).backgroundColor, surface);
    expect(contrast(fill, rest)).toBeGreaterThanOrEqual(3);
    // Its text is ink, and stays readable on the fill.
    const text = over(getComputedStyle(chosen.element()).color, surface);
    expect(contrast(text, fill)).toBeGreaterThanOrEqual(4.5);
    expect(getComputedStyle(chosen.element()).color).not.toBe(
      getComputedStyle(other.element()).color,
    );

    // Hovered, an unchosen item takes the muted wash (#282328), still 3:1 from the fill.
    await userEvent.hover(other.element());
    const hovered = over(getComputedStyle(other.element()).backgroundColor, surface);
    expect(hovered).toEqual([40, 35, 40]);
    expect(contrast(fill, hovered)).toBeGreaterThanOrEqual(3);

    // A hovered chosen item keeps its fill: the hover wash does not replace it.
    await userEvent.hover(chosen.element());
    expect(chosen.element().matches(":hover")).toBe(true);
    expect(over(getComputedStyle(chosen.element()).backgroundColor, surface)).toEqual(fill);

    // Choosing another moves the fill, through the same pressed state.
    await other.click();
    await expect.element(other).toHaveAttribute("aria-pressed", "true");
    await expect.element(chosen).toHaveAttribute("aria-pressed", "false");
    await userEvent.unhover(other.element());
    expect(over(getComputedStyle(other.element()).backgroundColor, surface)).toEqual(fill);
  });
});
