import * as React from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import "../../src/styles/globals.css";
import { OverflowTooltip, TruncatedText } from "../../src/components/truncated-text.tsx";
import { TooltipProvider } from "../../src/components/ui/tooltip.tsx";
import { trackMounted } from "./mounted.ts";

/*
 * TruncatedText (components/truncated-text.tsx): a tooltip with the whole
 * text only while an ellipsis cuts it off, on hover and on keyboard focus;
 * in a link, the link is the trigger and no tab stop is added.
 */

const LONG = "staging.demo-shop.example, www.demo-shop.example, demo-shop.example, more.example";

function mount(node: React.ReactNode) {
  document.documentElement.classList.add("dark");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  root.render(<TooltipProvider>{node}</TooltipProvider>);
  trackMounted(() => {
    root.unmount();
    container.remove();
  });
}

const tooltip = () => document.querySelector<HTMLElement>("[data-slot=tooltip-content]");
const tooltipText = () => tooltip()?.textContent ?? null;
/** Waits long enough for a tooltip to open, before asserting it did not. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

/** The times, over the next `ms`, of frames in which the tooltip was closed or closing. */
function closingsOver(ms: number): Promise<number[]> {
  const closings: number[] = [];
  const end = performance.now() + ms;
  return new Promise((resolve) => {
    const frame = (now: number) => {
      const shown = tooltip();
      if (shown === null || shown.hasAttribute("data-closed")) closings.push(Math.round(now));
      if (now < end) requestAnimationFrame(frame);
      else resolve(closings);
    };
    requestAnimationFrame(frame);
  });
}

/** A box whose width a test can change. */
function Box({ width, children }: { width: number; children: React.ReactNode }) {
  return (
    <div data-testid="box" style={{ width }}>
      {children}
    </div>
  );
}

describe("TruncatedText", () => {
  test("text that fits has no tab stop and no tooltip, on hover or focus", async () => {
    mount(
      <Box width={600}>
        <button type="button">Before</button>
        <TruncatedText text="short.example" />
      </Box>,
    );
    const text = page.getByText("short.example");
    await expect.element(text).toBeVisible();
    await settle();
    expect(text.element().getAttribute("tabindex")).toBeNull();
    await text.hover();
    await settle();
    expect(tooltip()).toBeNull();
  });

  test("cut-off text takes a tab stop and shows in full on hover and on focus", async () => {
    mount(
      <Box width={120}>
        <button type="button">Before</button>
        <TruncatedText text={LONG} />
      </Box>,
    );
    const text = page.getByText(LONG).first();
    await expect.poll(() => text.element().getAttribute("tabindex")).toBe("0");
    await text.hover();
    await expect.poll(tooltipText).toBe(LONG);
    // The tooltip itself never scrolls, so no scrollbar shows while it animates.
    const popup = tooltip();
    expect(popup === null ? null : getComputedStyle(popup).overflowY).toBe("visible");
    await page.getByRole("button", { name: "Before" }).hover();
    await expect.poll(tooltip).toBeNull();

    page.getByRole("button", { name: "Before" }).element().focus();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(text.element());
    await expect.poll(tooltipText).toBe(LONG);
    await userEvent.keyboard("{Escape}");
    await expect.poll(tooltip).toBeNull();
  });

  test("a very long text scrolls inside the tooltip, with the arrow outside the scroll", async () => {
    const huge = Array.from({ length: 80 }, (_, index) => `site-${index}.example`).join(", ");
    mount(
      <Box width={120}>
        <TruncatedText text={huge} />
      </Box>,
    );
    await page.getByText(huge).first().hover();
    await expect.poll(tooltipText).toBe(huge);
    const popup = tooltip();
    const scroller = popup?.querySelector<HTMLElement>("[data-slot=tooltip-scroll]");
    expect(scroller?.scrollHeight).toBeGreaterThan(scroller?.clientHeight ?? 0);
    expect(popup === null ? null : popup.scrollHeight - popup.clientHeight).toBe(0);
  });

  test("the lines form shows one item per line", async () => {
    const hosts = ["demo-shop.example", "www.demo-shop.example", "staging.demo-shop.example"];
    mount(
      <Box width={120}>
        <TruncatedText text={hosts.join(", ")} lines={hosts} />
      </Box>,
    );
    await page.getByText(hosts.join(", ")).first().hover();
    await expect.poll(tooltip).not.toBeNull();
    const items = [...(tooltip()?.querySelectorAll("span > span") ?? [])].map(
      (line) => line.textContent,
    );
    expect(items).toEqual(hosts);
    // Each on its own line: one under another.
    const tops = [...(tooltip()?.querySelectorAll("span > span") ?? [])].map(
      (line) => line.getBoundingClientRect().top,
    );
    expect(tops[1]).toBeGreaterThan(tops[0] ?? 0);
  });

  test("a line clamp counts as cut off only when its lines overflow", async () => {
    const words = Array.from(
      { length: 3 },
      () => "A message long enough to wrap onto more than two lines in a narrow box.",
    ).join(" ");
    mount(
      <>
        <Box width={160}>
          <TruncatedText text={words} className="line-clamp-2 text-sm" />
        </Box>
        <Box width={600}>
          <TruncatedText text="One short line" className="line-clamp-2 text-sm" />
        </Box>
      </>,
    );
    await expect.element(page.getByText(words).first()).toBeVisible();
    const clamped = page.getByText(words).first().element() as HTMLElement;
    // Clamped, it wraps (no ellipsis on one line) and stops at two lines.
    expect(getComputedStyle(clamped).whiteSpace).not.toBe("nowrap");
    await expect.poll(() => clamped.getAttribute("tabindex")).toBe("0");
    expect(page.getByText("One short line").element().getAttribute("tabindex")).toBeNull();
    // From the short one, so the pointer surely enters the clamped one.
    await page.getByText("One short line").hover();
    await page.getByText(words).first().hover();
    await expect.poll(tooltipText).toBe(words);
  });

  test("it measures again when its box is resized", async () => {
    function Resizable() {
      const [width, setWidth] = React.useState(1000);
      return (
        <>
          <button type="button" onClick={() => setWidth((now) => (now === 1000 ? 120 : 1000))}>
            Resize
          </button>
          <Box width={width}>
            <TruncatedText text={LONG} />
          </Box>
        </>
      );
    }
    mount(<Resizable />);
    const text = page.getByText(LONG).first();
    await expect.element(text).toBeVisible();
    await settle();
    expect(text.element().getAttribute("tabindex")).toBeNull();
    await page.getByRole("button", { name: "Resize" }).click();
    await expect.poll(() => text.element().getAttribute("tabindex")).toBe("0");
    await text.hover();
    await expect.poll(tooltipText).toBe(LONG);
    // Wide again while it is open: it fits, so the tooltip closes and the tab stop goes.
    await page.getByRole("button", { name: "Resize" }).click();
    await expect.poll(tooltip).toBeNull();
    expect(text.element().getAttribute("tabindex")).toBeNull();
  });

  test("as a link, the link is the trigger, with no tab stop added", async () => {
    mount(
      <Box width={120}>
        <button type="button">Before</button>
        <TruncatedText text={LONG} render={<a href="#to">{LONG}</a>} />
      </Box>,
    );
    const link = page.getByRole("link", { name: LONG });
    await expect.element(link).toBeVisible();
    await settle();
    expect(link.element().getAttribute("tabindex")).toBeNull();
    page.getByRole("button", { name: "Before" }).element().focus();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(link.element());
    await expect.poll(tooltipText).toBe(LONG);
  });

  test("inside a link, the link's hover and focus open it, with no tab stop added", async () => {
    mount(
      <Box width={140}>
        <button type="button">Before</button>
        <a href="#row" className="block">
          <TruncatedText text={LONG} />
          <span>Detail</span>
        </a>
      </Box>,
    );
    const text = page.getByText(LONG).first();
    await expect.element(text).toBeVisible();
    await settle();
    expect(text.element().getAttribute("tabindex")).toBeNull();
    // Hovering the link's other line opens it too.
    await page.getByText("Detail").hover();
    await expect.poll(tooltipText).toBe(LONG);
    await page.getByRole("button", { name: "Before" }).hover();
    await expect.poll(tooltip).toBeNull();

    page.getByRole("button", { name: "Before" }).element().focus();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(page.getByRole("link").element());
    await expect.poll(tooltipText).toBe(LONG);
    await userEvent.keyboard("{Escape}");
    await expect.poll(tooltip).toBeNull();
    await userEvent.keyboard("{Tab}");
    // The next tab stop is past the link: the text added none.
    expect(document.activeElement).not.toBe(text.element());
  });

  test("inside a link, a tooltip that opens under a still pointer stays open", async () => {
    // At the top of the page the tooltip opens below the text, over the
    // link's second line, where the pointer is. The tooltip's enter came
    // before the link's leave, so it closed 100ms later and opened again
    // 300ms after that, over and over.
    mount(
      <Box width={140}>
        <button type="button">Before</button>
        <a href="#row" className="block">
          <TruncatedText text={LONG} />
          <span>Detail</span>
        </a>
      </Box>,
    );
    await page.getByText("Detail").hover();
    await expect.poll(tooltipText).toBe(LONG);
    await expect.poll(() => tooltip()?.matches(":hover")).toBe(true);
    expect(await closingsOver(900)).toEqual([]);
    await page.getByRole("button", { name: "Before" }).hover();
    await expect.poll(tooltip).toBeNull();
  });

  test("inside a link, the pointer moving onto the tooltip and back keeps it open", async () => {
    mount(
      <div style={{ paddingTop: 120 }}>
        <Box width={140}>
          <a href="#row" className="block">
            <TruncatedText text={LONG} />
            <span>Detail</span>
          </a>
          <button type="button">After</button>
        </Box>
      </div>,
    );
    await page.getByText("Detail").hover();
    await expect.poll(tooltipText).toBe(LONG);
    const popup = tooltip();
    if (popup === null) throw new Error("no tooltip");
    const closings = closingsOver(700);
    await page.elementLocator(popup).hover();
    await page.getByText("Detail").hover();
    expect(await closings).toEqual([]);
    // Leaving for somewhere else still closes it.
    await page.getByRole("button", { name: "After" }).hover();
    await expect.poll(tooltip).toBeNull();
  });

  test("OverflowTooltip: one tooltip for a control's cut-off lines, or always", async () => {
    // Room above, so each tooltip opens there and covers none of the buttons.
    mount(
      <div style={{ paddingTop: 80 }}>
        <Box width={120}>
          <OverflowTooltip
            render={<button type="button" aria-label="Cut" className="block w-full" />}
            content="Both lines"
          >
            <TruncatedText text={LONG} />
            <TruncatedText text="short" />
          </OverflowTooltip>
        </Box>
        <Box width={600}>
          <OverflowTooltip
            render={<button type="button" aria-label="Always" />}
            content="Always"
            always
          >
            <TruncatedText text="fits" />
          </OverflowTooltip>
          <OverflowTooltip render={<button type="button" aria-label="Never" />} content="Never">
            <TruncatedText text="fits too" />
          </OverflowTooltip>
        </Box>
      </div>,
    );
    const cut = page.getByRole("button", { name: "Cut" });
    await expect.element(cut).toBeVisible();
    // The lines take no tab stop of their own: the button is the one.
    expect(cut.element().querySelector("[tabindex]")).toBeNull();
    // From elsewhere, so the pointer surely enters it.
    await page.getByRole("button", { name: "Never" }).hover();
    await cut.hover();
    await expect.poll(tooltipText).toBe("Both lines");
    expect(document.querySelectorAll("[data-slot=tooltip-content]")).toHaveLength(1);
    await page.getByRole("button", { name: "Never" }).hover();
    await settle();
    expect(tooltip()).toBeNull();
    await page.getByRole("button", { name: "Always" }).hover();
    await expect.poll(tooltipText).toBe("Always");
  });
});
