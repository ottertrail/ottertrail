# Ottertrail design system

Status: initial foundation. The name treatment and mascot are undecided; the mark in the app is a placeholder.

A dark interface for a dense dashboard: a near-black canvas, a ladder of surfaces instead of shadows, hairline borders, and a single orchid accent used sparingly. This document records the tokens, the reasons behind them, and the remaining gaps.

This document is the reference. The components in `apps/web/src/components/` are the source: to see a block, read its component and a screen that uses it. When a component changes what this document says, update the document in the same change. The dashboard has no page of examples. `apps/web/tests/browser/screen-patterns.test.tsx` renders the shared screen blocks directly, with test content, and walks their behavior: the filter bar, the stat strip, the report chart with a toggle group and its numbers, the breakdown table, pinned columns with the scroll hint and a missing value, the workbench, key hints and toggle groups, and the settings tabs with the save rule.

## Where things live

| What                                                                                                           | Where                                             |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Tokens (CSS variables, Tailwind theme, type scale, radius)                                                     | `apps/web/src/styles/globals.css`                 |
| shadcn/ui components (Base UI primitives, `base-nova` style)                                                   | `apps/web/src/components/ui/`                     |
| Ottertrail components (`StatusBadge`, `ApiStatus`, `TimezoneCombobox`, app shell)                              | `apps/web/src/components/`                        |
| Screen blocks (`FilterBar`, `StatStrip`, `BreakdownTable`, `ReportChart`, `ScrollHint`, `Workbench`, settings) | `apps/web/src/components/`                        |
| Tests of the screen blocks, rendered directly                                                                  | `apps/web/tests/browser/screen-patterns.test.tsx` |
| Contrast tests for the tokens                                                                                  | `apps/web/tests/tokens.test.ts`                   |
| shadcn configuration                                                                                           | `apps/web/components.json`                        |

Use tokens through Tailwind utilities (`bg-card`, `text-ink-subtle`, `ring-border`, `text-headline`), not raw hex values in components.

## Color

Dark only. `index.html` sets `class="dark"` and `color-scheme: dark`; all tokens live in `:root`.

### Neutrals

The greys carry a faint orchid tint (OKLCH hue 325, chroma 0.003 to 0.012), so the neutrals and the accent read as one palette. The tint is too weak to make surfaces look purple, and it does not affect contrast or the chart colors.

| Token               | Value     | Use                                                                                                                                                |
| ------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canvas`            | `#010101` | Page frame and sidebar                                                                                                                             |
| `surface-1`         | `#110f11` | Main content panel (`background`)                                                                                                                  |
| `surface-2`         | `#161416` | Cards (`card`)                                                                                                                                     |
| `surface-3`         | `#1a181a` | Popovers, menus, dialogs (`popover`); sidebar active item                                                                                          |
| `surface-4`         | `#1b191b` | Spare lift step                                                                                                                                    |
| `hairline`          | `#282328` | Borders, dividers; also the `secondary` and `muted` fills                                                                                          |
| `hairline-strong`   | `#373338` | Quiet control borders; the wash inside fields (`input-fill`)                                                                                       |
| `field-edge`        | `#746f75` | Field edges (`input`), switch tracks; 3:1 on fills and surfaces                                                                                    |
| `hairline-tertiary` | `#423d42` | Strongest divider                                                                                                                                  |
| `toggle-on`         | `#746f75` | The chosen item of a toggle group (`field-edge`'s value, its own token so it can be tuned alone)                                                   |
| `ink`               | `#f9f7f9` | Primary text (`foreground`)                                                                                                                        |
| `ink-muted`         | `#dad3da` | Sidebar text, secondary emphasis                                                                                                                   |
| `ink-subtle`        | `#938c93` | Descriptions, placeholders (`muted-foreground`)                                                                                                    |
| `ink-tertiary`      | `#69646a` | Decoration, disabled states, and a chart's de-emphasized part ("Other", No status, the quietest part of a state chart); about 3.2:1, so never text |
| `success`           | `#27a644` | Success text and status                                                                                                                            |

### Accent

| Token         | Value           | Use                                                             |
| ------------- | --------------- | --------------------------------------------------------------- |
| `brand`       | `#a557aa`       | Brand mark, primary buttons (`primary`), text selection         |
| `brand-focus` | same as `brand` | Focus rings (`ring`); a separate token so it can be tuned alone |
| `link`        | `#d588d9`       | Link text                                                       |

Orchid, a muted magenta (OKLCH hue 325).

- White text on `brand` is 4.62:1. Primary buttons use shadcn's hover (`bg-primary/80`), which darkens the fill over the surface; white text there is 6.1 to 6.3:1.
- The focus ring is 3.82:1 (popover) to 4.52:1 (canvas).
- `link` is 7.0:1 (popover) to 8.3:1 (canvas). It is too light for white text (2.51:1), so it is never a fill.
- Alternatives considered: river teal (`#1d8181`), lagoon blue (`#1d7da3`), and no accent hue (white primary buttons). A warm otter brown was rejected: its link step was almost identical to `status-serious` orange, and green, yellow, and red hues would clash with the success, warning, and danger colors in the same way.
- Trade-off: orchid is close in hue to `chart-5` (`#d55181`); keep the accent out of charts.

### Other decisions

1. **Layered app layout.** The sidebar sits on `canvas`, the main panel is an inset `surface-1` panel with a hairline ring, cards are `surface-2`, and floating layers are `surface-3`.
2. **`brand` is not a text color.** `#a557aa` is 3.82 to 4.13:1 on the content surfaces, below AA for body text. The four shadcn files that used `text-primary` for links (`button`, `badge`, `field`, `empty`) now use `text-link`.
3. **Warning and danger colors.** `warning` is `#fab219`. `danger` is `#f47373`: `#eb5757` was the first candidate but dropped to 3.92:1 as text on its own 20% tint (destructive badges and buttons use that pattern). `#f47373` reaches 4.64:1 there.
4. **Fills for `secondary` and `muted`.** The upper surface steps differ by only a few levels (`#161416` to `#1b191b`), so secondary buttons, tab lists, and skeletons on cards would be invisible. They use `hairline` (`#282328`) as a fill.
5. **Hover wash.** `accent` is `rgb(255 255 255 / 0.06)`, so menu-item and ghost hovers work on any surface.

### Status

`status-good`, `status-warning`, `status-serious` (`#ec835a`), and `status-critical` are reserved for state. Always render them through `StatusBadge` (icon + text label), never as color alone, and never reuse them as chart series colors for categories. Two exceptions, for state itself, each beside a badge or a legend that names it: a meter past its threshold, with its `StatusBadge` after the figure (below); and a chart whose parts are states with a badge of their own (the Logs chart's severities, the Traces chart's traces with errors) colors those parts as their badges are, with a legend and a readout that name every part (see [Charts](#charts)).

## Charts

The analytics page uses `chart-1` for its line and its bars ([dashboard.md](dashboard.md#84-analytics-page)). The line is 2px with a 10% wash under it, gridlines use `hairline`, and the hover crosshair uses `hairline-tertiary`; the bars are 6px high with a rounded end.

`--chart-1` through `--chart-8` are the dark steps of the dataviz reference palette (blue, orange, aqua, yellow, magenta, green, violet, red). Validated with the dataviz palette validator against `#110f11` and `#161416`: every slot sits inside the lightness band and above the chroma floor, worst adjacent colorblind separation is ΔE 8.4, worst adjacent normal-vision separation is ΔE 19.3, and every slot is at least 3:1 against the card surface.

Rules:

- Assign series in slot order and never cycle. A ninth series folds into "Other" or small multiples.
- Color follows the entity, not its rank. Filtering must not repaint the remaining series.
- Charts that compare every pair (scatter, bubble, choropleth) use at most the first 3 slots.
- One y-axis per chart. Two measures of different scale get two charts.
- Sequential (magnitude) data uses one hue in steps: `--seq-1` to `--seq-5` (`bg-seq-1` …), blue from `#172437` to `#2563ad`, each lighter than the one before, so on the dark canvas a larger value stands out more. Body text keeps at least 4.5:1 on every step (`tests/tokens.test.ts`), so a cell's number is always readable on it; the color is never the only way to read the value. First used by the retention table. Diverging data (two hues with a gray midpoint) has no ramp yet; add one with its first chart.
- Values, labels, and legends use text tokens, not the series color.
- On one page, a color means one thing. When a page's charts show different entities, such as status classes and percentiles, each takes slots no other on the page uses: a service's page gives the classes `chart-1` to `chart-4`, the failed share `chart-5`, and the percentiles `chart-6` to `chart-8`; a query shape's page keeps the same slots, its calls taking `chart-1`. The chart above the Services list keeps a service's page's slots (the classes, `chart-5` for the failed share, `chart-7` for the 95th percentile); the one above the Databases list gives calls `chart-1` and time spent `chart-2`.
- A meter shows one share of a whole beside its figure, such as a host's CPU busy (`hosts-page.tsx`): 48 by 6 pixels, rounded, its fill `chart-1` on a track of `seq-1`, the darkest step of the same blue, hidden from screen readers since the figure says the value. Past a threshold the fill takes a status color, and a `StatusBadge` with its icon and a word ("High") follows the figure, so the state is never color alone.
- A sparkline shows one row's shape over the period in a table (the Metrics list, `metric-sparkline.tsx`): 96 by 24 pixels, its own scale, no axis, a 2px line in `ink-subtle` broken where nothing arrived, and the latest value a dot in `chart-1`. Every row draws the same, so it needs no legend. It is decoration, hidden from screen readers and never focused, so a row adds no tab stop; visually hidden text beside it and its hover title give the lowest, highest, and latest values, and the row's own page has the chart. A sparkline with nothing to draw is a `Missing` dash named for the reason, never a flat line.
- A chart of a state (the Logs chart's records by severity, the Traces chart's traces with and without errors) uses the status colors for the parts that say something is wrong, the same ones their badges use (Error or worse and traces with errors `status-critical`, Warning `status-warning`), and neutrals for the rest: `chart-neutral` (`#b0a9b0`) for the normal part and `ink-tertiary` for the quietest. Apart from a meter past its threshold (below), these are the only charts whose parts take status colors. The problem part sits on the baseline. The dataviz validator, on `surface-1` (`#110f11`) and `surface-2` (`#161416`) alike: the Logs chart's four parts are at least ΔE 13.8 apart under color blindness (deutan, warning against critical) and 18.3 to normal vision (warning against the neutral); the Traces chart's two parts 8.2 (deutan) and 15.6; every part is at least 3:1 on both surfaces. The validator's lightness band and chroma floor fail for these parts by design, since status colors are fixed and the neutrals are meant to read gray. No chart slot is used, so a hue never means a category on one page and a state on another; the legend and the readout name every part, so color is never the only cue. Stacked bars (`stacked-bar-chart.tsx`) keep 2px of surface between parts and between bars, a rounded top, and one baseline.
- A thin segmented bar shows one whole split into parts, such as a route's requests by status class (`status-classes.tsx`): 8px high, rounded ends, a part per category with a value, in proportion, 2px apart, no text, with a legend naming the parts and a table view. Hover, keyboard focus, and its accessible name give every part's count and share.

## Typography

Ottertrail self-hosts **Inter Variable** (with the optical-size axis, so large sizes get Inter's display cut) and **JetBrains Mono Variable** through Fontsource. Fonts ship with the app, so no instance makes requests to a third-party font CDN.

| Utility                        | Size / line height / tracking / weight |
| ------------------------------ | -------------------------------------- |
| `text-display-xl`              | 80px / 1.05 / -3px / 600               |
| `text-display-lg`              | 56px / 1.10 / -1.8px / 600             |
| `text-display-md`              | 40px / 1.15 / -1px / 600               |
| `text-headline`                | 28px / 1.20 / -0.6px / 600             |
| `text-card-title`              | 22px / 1.25 / -0.4px / 500             |
| `text-subhead`                 | 20px / 1.40 / -0.2px / 400             |
| `text-body-lg`                 | 18px / 1.50 / -0.1px / 400             |
| `text-body`                    | 16px / 1.50 / -0.05px / 400            |
| `text-body-sm`                 | 14px / 1.50 / 0 / 400                  |
| `text-caption`                 | 12px / 1.40 / 0 / 400                  |
| `text-code` (with `font-mono`) | 13px / 1.50 / 0 / 400                  |

The dashboard is dense: controls and body copy use shadcn's `text-sm` (14px) and `text-xs` (12px). Display sizes are for page titles and empty marketing-like moments, not for data screens.

No eyebrows and no tracked capitals. A label, caption, table head, tab, tag or key hint is the body face a step smaller, in sentence case and untracked. A line of small type over a heading that only announces it goes; where the heading needs it, the plain words become the heading. The `text-eyebrow` style was removed for this reason.

Figures that compare (stat strips, table columns, times) use tabular numerals (`tabular-nums`).

## Shape and spacing

Spacing uses Tailwind's 4px scale.

The theme redefines Tailwind's radius scale so shadcn's component classes produce these values without local edits:

| Tailwind      | Value  | Used by                  |
| ------------- | ------ | ------------------------ |
| `rounded-sm`  | 4px    | Small chips              |
| `rounded-md`  | 6px    | Menu items, tab triggers |
| `rounded-lg`  | 8px    | Buttons, inputs          |
| `rounded-xl`  | 12px   | Cards, dialogs           |
| `rounded-2xl` | 16px   | Screenshot panels        |
| `rounded-3xl` | 24px   | Large panels             |
| `rounded-4xl` | 9999px | Badges                   |

No drop shadows for hierarchy; use the surface ladder and `ring-1 ring-border`.

## Components

- Generated with `shadcn@4.23.0`, style `base-nova`, primitives from Base UI (`@base-ui/react`), icons from `lucide-react`. Base UI composes with a `render` prop where Radix used `asChild`.
- Add components from `apps/web` with the pinned CLI: `pnpm dlx shadcn@4.23.0 add <name>`, then run `vp check --fix` from the repository root to apply formatting. Pin any dependency the CLI adds to an exact version in `pnpm-workspace.yaml`'s catalog (Resizable added `react-resizable-panels` 4.24.0).
- Added with that CLI: Radio Group, Toggle Group (with Toggle), Resizable, and Avatar (the sidebar's user, initials only). Popover was added too and removed when nothing used it; add it again with the CLI when a screen needs one.
- Local changes to generated files: the `text-link` substitutions above; `hooks/use-mobile.ts` rewritten with `useSyncExternalStore` (the generated version set state inside an effect); `select.tsx`, whose list opens below its trigger, aligned to its start (`alignItemWithTrigger = false`, `align = "start"`), where Base UI's default lays the list over the trigger so that the chosen item sits on it, which covered the controls above (the tabs over a page's period filter); and these, from the redesign's first phase:
  - **Field washes:** `bg-input/…` became `bg-input-fill/…` (input, textarea, select, combobox, checkbox, radio group, tabs, button), because `input` is now the 3:1 field edge; the outline button's and the active tab's border became `border-hairline-strong`, so they stay quiet. Error borders are full `border-destructive`, not `/50`, which fell to 2.5:1 (combobox included).
  - **Switch track:** the unchecked track is `bg-input` at full strength, not `/80`: the track is the switch's boundary, so it takes the field edge, 3.6 to 3.9:1 on the surfaces, with the thumb (`foreground`) 4.6:1 on it.
  - **No `transition-all`:** badge, button, switch, tabs and toggle use `transition-colors`. The sidebar no longer animates its width, position or padding (the gap, the container, the menu buttons), and its group label fades without moving its margin: Hallmark's Floor bans animating size and position.
  - **The sidebar's breakpoint:** its `md:` classes became `min-[60rem]:`, with `hooks/use-mobile.ts` matching `(width < 60rem)`, so the sheet takes over under 60rem. The sheet's title is "Menu".
  - **Overlays:** the dialog and sheet backdrops are `bg-canvas/70` without the backdrop blur.
  - **Dropdown shortcuts** are untracked (`tracking-widest` removed).
  - **The pointer on items:** `cursor-default` is gone from the menu items (item, submenu trigger, checkbox and radio items), the select's items and the combobox's items, so the base cursor rule (see [Accessibility](#accessibility)) gives them the pointer: each one acts when clicked. The select's scroll arrows keep `cursor-default`, since they scroll on hover.
  - **Table rows:** `TableRow` has no hover wash of its own; only a clickable row has one (`clickableRow`, see [Clickable rows](#clickable-rows)), so a row that opens nothing does not react to the pointer.
  - **Toggle's chosen item:** `toggle.tsx` fills the pressed item with `toggle-on` and writes it in `ink`; unpressed items are `ink-subtle` on no fill, `muted` and `ink` on hover. See [Toggle groups](#toggle-groups).

  Keep these when updating components.

- Use a shadcn component wherever one exists for the job (a radio group, a toggle group, tabs, a popover, a sheet, a dialog, a table), added with the CLI below, rather than a hand-built control; build one by hand only when shadcn has none, in the generated files' style, as `combobox.tsx` is.
- The root lint config relaxes five rules for `components/ui/*.tsx` only, so upstream updates stay reviewable.
- A link that looks like a button is `ButtonLink` (`components/button-link.ts`), which takes the router's link props. Do not render a `Button` as a link (`render={<Link />}`): Base UI gives the rendered element the button role, so screen readers announce the link as a button.
- A text field that filters a long list of choices is `Combobox` (`components/ui/combobox.tsx`, written by hand in the generated files' style, on Base UI's Combobox, which gives it the `combobox`, `listbox`, and `option` roles and the keyboard: arrows, Enter, Escape). `ComboboxInput` is the field, styled like `Input`, with a button that opens the list; its other props go to the `<input>`, so a `<label htmlFor>` names it. `ComboboxContent` is the floating list on `popover`, as wide as the field and at most 18rem high, scrolling inside; `ComboboxItem` marks the chosen option with a check; `ComboboxEmpty` says when nothing matches and stays mounted as a live region. Use it instead of an `<input list>` with a `<datalist>`, which browsers show as an unstyled native list. The timezone fields use it through `TimezoneCombobox` (`components/timezone-combobox.tsx`). A `datalist` stays only where any value may be typed past the suggestions, such as the alert rules' and the funnel editor's fields.
- **Buttons:** one primary action per view (`Button`'s default variant, on `brand`). `secondary` and `outline` are the other actions, `ghost` an action inside a row or a toolbar, `destructive` an action that deletes, and `link` an action that reads as text. An icon-only button (`size="icon"`) has an `aria-label`.
- **Fields:** every field has a visible label (`FieldLabel`, or `Label` beside a checkbox, radio or switch); a placeholder is never the label. A `FieldDescription` under it says what the value is for or what it changes. An error (`FieldError`, tied to the field with `aria-describedby`, the field marked `aria-invalid`) says what is wrong and how to correct it. Radios and a set of checkboxes sit in a `<fieldset>` with a `<legend>`.
- Text to copy, such as an install snippet or a key, is `CopyableCode` (`components/copyable-code.tsx`): code that wraps, with its copy button inside the box. Never a read-only input, which looks editable, and never inside a form whose Save button would not store it.

### Data states

Every region that loads data needs four states:

- **Loading:** skeletons (`ui/skeleton.tsx`) shaped like the content they replace, in a container with `aria-busy` and a label that names what loads ("Loading the summary"). A stat strip's loading state is a short bar for each label over a taller one for each figure; a table's is its title and a few row-high bars; a workbench list's is a few bars as high as its rows. A page whose code is still downloading shows `PagePending` (`components/route-states.tsx`): a filter bar, a strip of figures, a chart and rows.
- **Empty:** say why there is no data and what to do next, in the region's place: `Empty` (`ui/empty.tsx`) with an icon, a title that says why ("No unresolved errors in this period") and a line on how to start. A breakdown table takes its `empty` text instead of drawing an empty table. A workbench with an empty list shows how to start in its detail pane (`summary`).
- **Failure:** say what failed and offer a retry: a `destructive` `Alert` with a title that names what failed ("The errors could not load"), a line on why when it is known, and Retry as its `AlertAction`. Never show stale data as current.
- **Delayed data:** use a `warning` `StatusBadge` with a label that names the delay. No component exists for this yet.

Plus the full state. A region that refreshes keeps its last data, dimmed, and says when a refresh failed; it never shows it as current.

## Screen patterns

Every screen takes one of three patterns, by what it is for. The blocks live in `apps/web/src/components/`, and each takes the [data states](#data-states) above. The approved mockups behind them were the Console (reports) and Workbench (lists and settings) directions.

| Kind of screen   | Pattern           | Screens                                                                                                 |
| ---------------- | ----------------- | ------------------------------------------------------------------------------------------------------- |
| Report           | Console           | Overview, Web analytics, Speed, Heatmaps, Product analytics, Services, Databases, Hosts, Metrics        |
| List with detail | Workbench         | Errors, Replays, Traces, Logs, Users, Uptime, Alerts                                                    |
| Settings         | Tabs and Save bar | Project settings, instance Settings, Account settings, Members (tables, with a sheet for Change access) |

### The shell

- The sidebar is expanded on every screen, on `canvas`, with the main panel inset beside it (`surface-1`, a hairline ring). Ctrl B (⌘ B on a Mac) or the header's button collapses it to icons; `lib/sidebar-state.ts` remembers the choice in `localStorage` (`ottertrail.sidebar`). The header shows the shortcut.
- The sidebar's head holds the mark, "Ottertrail" and the API's health (`ApiStatus`) at its right; collapsed, the health is a dot on the mark's corner with the same accessible name and a tooltip. Its foot is shadcn's NavUser block (`app-shell/user-menu.tsx`): a `size="lg"` menu button with the avatar (initials), the name and email cut off with an ellipsis, and `ChevronsUpDown`, opening a menu (to the right on a desktop, below on a phone) with the user, Account settings, a separator and Sign out. Collapsed, only the avatar shows, with a tooltip.
- **Text cut off with an ellipsis** shows whole in a tooltip, on hover and on keyboard focus, and only while it is cut off (`scrollWidth > clientWidth`), never as a bare `title`. For now `components/truncated-text.tsx` does this where the account work cuts text off (the sidebar's user, the sessions' browsers): `TruncatedText` for a line of text, which takes a tab stop only while cut off, and `OverflowTooltip` for a control holding such lines (`focusable={false}`). A shared component is to replace both, and the truncation across the app. A menu wraps long text instead of cutting it off.
- Under 60rem the sidebar is shadcn's sheet: the header's first button becomes "Open menu", and choosing a link closes the sheet (`app.tsx`).
- The header holds the menu button, the breadcrumb (the project, then the page title as the page's `h1`), and at its end the screen's Docs link and the shortcut hint. The Docs link is a small ghost button (`ButtonAnchor`, `size="sm"`, the `BookOpen` icon and "Docs" in `ink-subtle`), shown only on screens with a docs page (`lib/docs.ts`); under 40rem it is the icon alone, 28px with a 44px touch target, its name unchanged ([dashboard](dashboard.md#the-workspace-and-a-project)).
- Page content sits inside `px-gutter`: 24px, 16px under 40rem. Nothing scrolls sideways at 320 to 1920 except a table inside its own container.

### Report (Console)

A report reads top to bottom, with no cards around its parts; hairline rules and spacing separate them.

1. **`FilterBar`** (`filter-bar.tsx`): a `<search>` landmark pinned under the header (from 40rem; on a phone it scrolls away). Slots, in order: `period` (a Select), `environment` (only when there is a choice), `filters` (active filters, or a Toggle Group such as Unresolved, Resolved, All), and at the end `range` and `actions`. It wraps on narrow screens. `FilterBarRange` writes the days and the timezone as two items.
2. **`StatStrip`** (`stat-strip.tsx`): the figures in one row, parted by hairlines, as a `<dl>`: a label, the figure in tabular numerals, and optionally its change from the period before (an arrow and a size, read out as a sentence such as "Up 12% from 683"). A stat's `counts` are what its change rests on: its own count in this period and the one before (for a share, the counts it is taken of). With a `minCount`, the change shows only when the larger of the two reaches it, because a few visits make any percentage look large; with no `counts`, it is left out. When the period before had none, a stat that reaches the minimum reads "New" instead of a percentage. One rule for every figure: `shownChange` in `lib/change.ts`; a report whose API gives no period before (Speed, an event, a service, a query shape) shows no change. A stat's optional `detail` goes under its figure, in small text: a rating badge, a spread, how many loads it was measured on (the Core Web Vitals on the Speed page). Labels wrap rather than cut off. Two columns on a phone, four up to 64rem, one row above; a page passes `className` for another count (three on the Speed page, one column on a phone for the vitals). No icon tiles and no trend nobody measured.
3. **A short chart**, wide and low, per the chart rules above: `ReportChart` (`report-chart.tsx`) is one chart's section, a hairline above, its title with "Show the numbers" beside it (and any toggle, through `actions`), a line on what it draws, the chart, and its table view under it once asked for. The plot is 140px high (`plotHeight` on `DayChart` and `TimeChart`). The telemetry pages draw theirs with `ChartSection` (`features/telemetry/chart-card.tsx`), full width, one under another; `ChartCard` stays for charts in a card (an uptime check's page).
4. **`BreakdownTable`** (`breakdown-table.tsx`), two or three side by side from 64rem: a compact `ui/table` with the name, an inline bar in proportion to the largest row (`chart-1`, one baseline), and the figures right-aligned in tabular numerals. A Toggle Group in its header (`views`; buttons with `aria-pressed`, named "Which pages to list") switches the one table between lists of one kind (Top pages, Entry, Exit): not tabs, which would promise a panel per tab; `showAll` holds the "Show all" control; `empty` says why there are no rows. On phones the table either scrolls inside itself with the name column pinned (`layout="scroll"`, the default) or stacks each row into a block, the name over its bar and the figures labelled (`layout="stack"`). Inside a card, set `--block-surface` to `var(--card)` so the pinned column matches. With more than two figures (the Speed page's loads, LCP, INP, and CLS), the figure columns are 5rem and the name takes what is left, so the table fits half the content's width. `description` puts a line under the title ("On 140 events"). A row's `action` follows its name in the name cell, never cut short with it: a small icon link with an accessible name (the Pages lists' "Heatmap of /pricing") or a mark in words (a "Rage clicks" badge). A scrolling table carries the scroll hint.
5. **Wider tables** (a service's routes, a database's query shapes, hosts, metrics) are `ui/table`s with small untracked heads, inside `ScrollHint` (`scroll-hint.tsx`): on a phone the table scrolls inside itself, its first column pinned (`PINNED`, `pinned-column.ts`) and, when the last column holds the row's actions (open its trace, add an alert rule), that one pinned at the other edge (`PINNED_END`); a fade at the edge says more columns wait, drawn just inside a column pinned at the end, above the cells that scroll under it. Both pinned columns are opaque, and a marked row (`aria-current`) keeps its highlight on them. A first column too wide to pin beside the actions (a call's start time) scrolls instead. At 1440 they fit without scrolling.
6. **Side by side by the container.** Blocks that sit side by side do so by the content's width (`@container`, `@3xl`, `@5xl`), not the window's, since the sidebar takes 16rem: two tables of the Speed page or a query shape's page side by side from 64rem of content.

A report's detail page (an event, a service, a query shape, a host, a metric) keeps the same order: the filter bar, then a link back to its list and its name as the page's second heading, its strip of figures, its charts, its tables. `ReportFilterBar` (`features/errors/range-controls.tsx`) is the filter bar with the period, the environment, and the days filled in; a page adds its own filters (a device, an event's property filters, a metric's split, measure, and narrowing).

### Workbench

A list on the left and the selected item on the right (`workbench.tsx`), on shadcn's Resizable (the list starts at 40%, 25 to 65%).

- **The selection is in the address** (`param`, such as `?error=<fingerprint>`), through TanStack Router (`hooks/use-search-param.ts`), so it survives a reload. A click adds a history entry; `j`, `k` and `Esc` replace it, so Back returns to where the list was opened rather than through every step.
- **Nothing is selected on arrival.** The detail pane shows `summary`: the list summed up (counts, what needs attention), or with an empty list, how to start.
- **Keys:** `j` and `k` select the next and previous item (`j` with nothing selected takes the first), `Esc` clears the selection, and one `action` key acts on the selected item (`e` resolves or reopens an error). They do nothing while focus is in a text field, an open list, a menu or a dialog (`lib/keys.ts`); a closed Select is a button, and the keys work after choosing in it. `WorkbenchKeyHints` lists them in the filter bar, from 64rem. A key hint is each key in a `Kbd` (keys pressed together side by side, in a `KbdGroup`), then what it does in plain words, in lower case: "j k move through a list", "e resolve or reopen", "Esc clear the choice".
- **Focus** follows `j` and `k` to the chosen row, and moves to it when an item is chosen from inside the detail pane (a name in the summary), whose content then goes. When an action takes the selected item out of the list (resolving an error under Unresolved), `j` and `k` carry on from its last place. When the selection clears (`Esc`, Back) with focus in the detail, focus returns to the row that was chosen, or the list.
- **Rows** carry `data-workbench-id`, so the selection scrolls into view, and mark the chosen row with `aria-current` on its link or button and `data-state="selected"` (a 2px `brand` rule at its start). Row controls stay on one line and truncate, with the whole text in `title`. A click anywhere on a row selects it, as a click on its name does ([Clickable rows](#clickable-rows)); `workbenchRow(id, chosen)` gives a row all of these.
- **Under 64rem** the list fills the screen and choosing an item calls `onOpenPage`, which goes to the item's own page. `narrowNow()` reads the width at the moment of the click or key, so `j`, `k`, `Esc` and the action key do nothing there. A selection that appears while the screen is narrow (an address opened there, a link) does the same once: the list's entry loses the selection first, so Back returns to the list. Every item keeps its full page.
- **One tree at every width.** The list, the detail pane, and the dialogs and live regions inside them keep their place in the React tree across 64rem; CSS switches the layout. Under 64rem it hides the resize handle and the detail pane (`display: none`) and gives the list the whole row. The pane renders from the first moment the screen is wide, then stays mounted. The summary, which holds no dialog, shows once at a time: in the pane from 64rem, and as the footer (`narrowFooter`) under it, each mounted only at its width; a screen without a footer keeps its summary in the hidden pane. `useMediaQuery` gives the render the width, for the rows' selected mark, the footer, and what the pane's content reads (`components/workbench-pane.ts`).
- **A window that narrows with an item selected** (a tablet turned) keeps the selection in the address and the item's pane mounted but hidden. A dialog opened from the pane, such as a check's edit form or a rule's delete confirmation, stays open with what was typed in it. A list of choices, a menu, or a popover opened from the pane closes, as with Escape, since its anchor is hidden. The list shows no row as selected. Focus that was in the pane, or in a list of choices it opened, moves to the selected row; focus in a dialog stays there, and a dialog closed while the pane is hidden returns focus to the selected row (`DialogContent`'s default `finalFocus`). Widening again shows the pane as it was, with the row marked. Choosing a row while narrow takes the hidden selection out of the list's entry, then opens that item's page, so Back returns to the list. A selection that replaces the hidden one (a deleted check's neighbour) stays hidden.
- **The panels' sizes survive the switch.** The resizable group stays mounted, and its layout is in percentages: under 64rem the hidden pane has no width and the list's panel is forced to grow over its inline size, so the library keeps the shares it had. The group is disabled there, so the hidden handle takes no pointer. Widening again restores the list's share as the reader last dragged it. The sizes are kept for the page's life, not stored.
- **A hidden pane is idle.** `useWorkbenchPane()` tells the pane's content whether it shows. While it is hidden, the queries that poll stop (`usePanePolling`: the check on Uptime; on Alerts, the rules and checks a rule's detail reads, and the firing alerts and history in the pane) and start again as it shows, at their next interval; a replay's player is asked to pause. Outside a workbench, on an item's own page, the pane counts as shown.
- Screens keep their own narrow content inside the list: an empty list's guidance takes the list's place on Errors, Replays, Traces, and Users, and Logs opens records in place. That content follows the width, so a record opened in place on Logs closes when the window widens; it holds nothing typed.
- A list's quick actions (an alert rule's on or off, a check's pause) stay instant, on the row. Deleting the selected item selects the one after it (the one before, at the end), with focus on its row.
- **Rows' parts** are in `workbench-rows.ts`: `workbenchRow` (the ID, the selected mark, and the row's click), `ROW_LINK` (marks the name the row's click stands for), `selectOnPlainClick` (a plain click on a row's link selects the row; one that opens a new tab follows the link), the list table's classes (`LIST_HEAD`, `GUTTER_START`, `GUTTER_END`, `SELECTED_ROW`), and `atLeast`, which writes a count from a list the API pages or caps as "50+" while more wait. `WorkbenchStartHint` (`workbench.tsx`) is the summary's last line, "Select a …, or press j to start at the top."
- **A summary counts only what it can.** A figure taken from the items loaded reads "at least" while more wait, and says so; a figure the API counts whole (a period's services, an error's replays) says what it covers. A filter that cannot list a kind (warnings under "Error and above") drops its figure rather than showing 0.
- **Filters keep the selection** on Replays, Traces, and Logs: an item a filter leaves out stays in the detail pane. New filters make a new list, so `j` starts at its top (`filterKey`), not at the old place. Errors' status filter clears the selection, as Unresolved and Resolved split one set of groups in two.
- **What belongs to the selection** goes with it (`selectionSearch`): choosing a trace sets `at` to its row's start and drops the span of the trace before.
- **Under 64rem, what has no page of its own follows the list** (`narrowFooter`): every check's uptime on Uptime, and the alerts firing now, the recent alerts, the hourly cap, and the link to the channels on Alerts. Anything else the summary shows is one step away, on an item's page.
- **The detail is the item's own page's view** (`ErrorView`, `ReplayView`, `TraceView`, `LogRecordView`, `UserView`, `CheckView`, `RuleView`), laid out by its own `@container`, not the window, so tables fit the pane. With `inWorkbench`, links that would leave for the same kind of item stay on the workbench (a missing item's "All …" link clears the selection; a linked trace opens beside the list). A log record has no page: under 64rem its list opens records in place, and an address with a selection opens that one.

### Clickable rows

A row that is one item opening one thing takes a click anywhere on it: the Workbench lists (Errors, Replays, Traces, Users, Uptime, Alerts; on Logs the record's button already spans the row), the projects list, the Members page's members (each opening Change access, where the viewer may change them), the report tables whose rows each open a page (Metrics, Hosts, a database's query shapes, a service's routes), and a trace's spans, each row choosing its span. `clickableRow()` (`components/clickable-row.ts`) gives a `TableRow` its props; `ROW_LINK` marks the name the row stands for.

- **The name stays the control.** The row's name is the real link or button, which the keyboard and screen readers use; the row's click is a mouse convenience that focuses and clicks the name, so it does exactly what the name does (selects in a workbench, opens the page under 64rem, opens Change access on Members), and Tab carries on from that row. The row takes no role and no tab stop.
- **The row's own controls act alone.** A click on a link, button, switch, field or label in the row (Uptime's edit, pause and delete, Alerts' on or off switch, the traces and alert-rule icons on Services, the projects list's Settings) does only its own action. A control that only shows a tooltip (a route's status-classes bar) carries `data-row-passthrough`: a click on it is the row's, and it takes the row's pointer. A click inside a dialog or menu the row opened does nothing to the row, though React passes it up through the portal.
- **New tabs.** Cmd or Ctrl on the row, or a middle click, opens the name's link in a new tab (`window.open`; whether the tab opens in front is the browser's choice) and leaves the list and its selection as they were. Shift (which extends a text selection) and Alt do nothing to the row. A name that is a button (Logs) has no page to open apart, so the row stays as it is.
- **Text selection.** A click that ends a drag selecting text in the row does not select the row. A double or triple click on a word acts on its first click: in a workbench that only selects the row, but in a row that opens a page (projects, hosts, query shapes, routes, metrics) it opens the page. To copy from such a row, drag over the text, or copy it from the item's page.
- **Look.** The pointer, and a `muted` wash at 50% on hover, on clickable rows only. A row that opens nothing (a summary, a breakdown, a route without a name, a metric without a name) has neither. A chosen row keeps its mark.
- **Not here:** `BreakdownTable`'s rows (pages, sources): a row there filters or shows a share, not one item's page.

### Toggle groups

A toggle group (`ui/toggle-group.tsx`, on `ui/toggle.tsx`) is a set of pressed buttons (`aria-pressed`, Base UI's `data-pressed`): Errors' Unresolved, Resolved and All, a breakdown's views, a chart's measure, the Services and Databases trends.

Use one when its choices switch one view (one table, one chart) between lists or measures of one kind. It is not tabs: the choices share one table or chart, so there is no panel per choice, and tabs would promise one. Use tabs (`SettingsTabs`, `ui/tabs.tsx`) when each choice has its own content. The group has a name that says what it chooses ("Which errors to list", "Which figure to chart"). Exactly one item is chosen: pressing the chosen item again keeps it chosen. What it shows changes at once, with no Apply button. The chosen item is filled with `toggle-on` and written in `ink`; the others are `ink-subtle` on no fill, with a `muted` wash and `ink` text on hover. The weight stays `font-medium` for all, so choosing an item never moves the others.

Contrast (WCAG 1.4.11, non-text, at least 3:1; `tests/tokens.test.ts` and `tests/browser/controls.test.tsx`): the fill is 3.88:1 on `background`, 3.73:1 on `card`, 3.59:1 on `popover`, 4.25:1 on `canvas`, and 3.14:1 on a hovered item's `muted`. The unchosen items have no fill, so the fill against them is its contrast on the group's surface. `ink` on the fill is 4.61:1; `ink-subtle`, the unchosen items' text, is 5.83:1 on `background`, 5.60:1 on `card`, 5.39:1 on `popover` and 6.37:1 on `canvas`; `ink` on a hovered item's `muted` is 14.47:1. The focus ring is unchanged.

### Settings tabs and the Save bar

- **`SettingsTabs`** (`settings-tabs.tsx`): the page's sections as line tabs, the chosen one in the address (`?tab=<value>`; the first tab is the default and leaves it out). Every panel stays mounted, so edits in one tab survive a visit to another, and a tab with unsaved changes shows an "Unsaved" badge after its label, read as "Settings, unsaved changes". The tab row scrolls sideways on a phone rather than wrapping.
- **`SettingsSection`** (`settings-section.tsx`): one titled section. With a `form` (from `useDirtyForm`) it is a `<form>` with its own **Save bar**, sticky at the foot of the screen while the form is in view: an `<output>` that says "No unsaved changes" or "Unsaved changes", Discard while there is a change, and Save. Save stays focusable while disabled (`aria-disabled`, Base UI's `focusableWhenDisabled`), so focus never drops to the page during or after a save; it still looks disabled (50% and the not-allowed cursor, styled on `aria-disabled`). Without a `form` (an install snippet, a key, a danger zone) it has no Save bar. `headingLevel={3}` puts it under a heading of the page's own (a member's name); `wide` lets its content run to a table's width (the notification channels).
- **`useDirtyForm(initial, { key, normalize })`** (`hooks/use-dirty-form.ts`) compares the edits with the saved values by content (a missing key and `undefined` are the same).
  - `initial` is always the server's latest values. When it changes, fields the user has not edited take the new values, and Discard restores the latest. When the server changed a field the user also edited, the user's value stays and the Save bar says "This section changed on the server while you edited it.", with "Load the new values".
  - `saved(submitted)` marks the values the request sent as saved; anything typed while it ran stays, and keeps the form dirty.
  - `key` (the project's ID) starts the form again from `initial` when it changes. The project routes also remount when the project changes (`remountDeps` in `router.tsx`), so no page carries one project's state into another.
  - `normalize` compares a field by something else: `Number` for a number typed as text, `ignoreOrder` for a set-like list.
- **`UnsavedChangesGuard`** (`unsaved-changes-guard.tsx`, built into `SettingsTabs`): while any form inside has unsaved changes, leaving the page asks first. A link or the Back button opens "Leave without saving?" (Stay on this page, or Leave and discard, which discards every form's edits), through TanStack Router's `useBlocker`; closing or reloading the tab gets the browser's own question (`beforeunload`). Forms report a save or a discard at once, so a handler that saves and then navigates is not asked. Moving between tabs on the page is not asked about.

### The save rule

- Each section's Save is disabled until something in it changes, and disabled again when the change is undone. (This is the one place a submit button is disabled at rest: the user chose it, so an unchanged form cannot be "saved".)
- "Unsaved changes" and Discard show while there is a change. Save says "Saving…" while the request runs; a failed save shows why above the bar and keeps the edits.
- Leaving with unsaved changes asks first, in the app and when the tab closes.
- Controls that used to save at once (the signed user IDs switch, the replay mode) are fields of their section's form.
- Quick actions on a list item (an alert rule's on or off) stay instant.
- Destructive actions confirm in a Dialog; deleting a project needs its name typed.

### Before signing in

The sign-in, setup, invitation and reset pages share `AuthLayout` (`features/auth/auth-layout.tsx`): the canvas, the brand mark, and one panel, 26rem at most, on `background` with a hairline ring, holding the page's `h1`, one line on what it does, and its form. Under 40rem the panel drops its frame and the form takes the width. No illustration, no marketing copy.

### Responsive rules

Two breakpoints, in rem so they follow the reader's font size, with one more for the workbench:

| Width       | What changes                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| under 40rem | Gutters 16px. The filter bar scrolls away instead of sticking. Breakdown tables scroll inside themselves or stack. Stat strips take two columns. |
| under 60rem | The sidebar is a sheet behind the header's menu button. Multi-column layouts go to one column.                                                   |
| under 64rem | A workbench shows its list alone; an item opens its own page. Breakdown tables stop sitting side by side.                                        |

Hooks: `useMediaQuery` with `PHONE`, `NARROW_SHELL`, and `NARROW_WORKBENCH` (`hooks/use-media-query.ts`); a list leaves out on a phone a column its item's page has (`PHONE`) rather than hiding cells, which in a fixed table would shift the others; in classes, `sm:` (40rem), `min-[60rem]:` and `min-[64rem]:` or `lg:` (64rem). Every screen is tested at 390 and 1440 wide. Controls are 32 to 40px high with a 44px hit area on a phone, and never wrap their labels.

### Dates

- A range is written with "to": "10 to 16 Nov 2026", "28 Nov to 4 Dec 2026", "19 Nov 2025 to 18 Nov 2026" (`formatDayRange` in `features/analytics/format.ts`); a time range likewise, "10:00 to 11:00", naming the end's day when it is the next one ("Mon 16 Nov 2026, 23:00 to Tue 17 Nov 2026, 00:00"). Never a dash.
- The range and its timezone are two items, side by side (`FilterBarRange`), never joined.
- No middle dot joins anything in the interface: list parts with commas ("Firefox, Linux, desktop"), name a thing in words ("shop on postgresql", "release 1.4.2"), separate parts that hold commas with semicolons ("Firefox, Linux; Munich, Germany; release 1.4.2"), put a detail in parentheses ("Asia/Singapore (UTC+8)"), or lay items out apart. Items set apart only by a gap still read as one run of text to a screen reader: give them words ("API health, rule API down, since …"). The en dash stays only as the placeholder for a missing value ("–"): `MISSING` (`lib/missing.ts`) in formatters, and `<Missing label="Not sent" />` (`components/missing.tsx`) in a table, which hides the dash from screen readers and says what is missing in words.

## Accessibility

`apps/web/tests/tokens.test.ts` enforces these guarantees on every test run:

- Text tokens (`foreground`, `ink-muted`, `muted-foreground`, `link`, `destructive`, `success`, `warning`) are at least 4.5:1 on `background`, `card`, and `popover`.
- Foreground/background pairs for primary, secondary, muted, sidebar, and sidebar-accent are at least 4.5:1.
- Status text on its own tint (badges) is at least 4.5:1.
- The focus ring and every chart and status mark are at least 3:1 on their surfaces.
- Field edges (`input`) are at least 3:1 on `background`, `card` and `popover` (WCAG 1.4.11), and also on the field's own wash at rest (`input-fill` at 30%) and on hover (50%). The wash stays a quiet step off its surface (above 1.03:1, below 1.5:1). A switch's unchecked track (`input`) is 3:1 on the surfaces, and its thumb 3:1 on the track.

**The pointer.** A base rule in `globals.css` gives every enabled control a click acts on `cursor: pointer`, since Tailwind 4's preflight leaves buttons at the default arrow: buttons and `role="button"`, toggle items, tabs, switches, checkboxes, radios, select and combobox triggers (a combobox's text field keeps its text cursor), menu items and list options, `<summary>`, native checkboxes and radios, and a label around a checkbox, radio or switch. Disabled controls (`:disabled`, `aria-disabled="true"`, `data-disabled`, or a label around one) keep their own cursor: the default arrow, or `not-allowed` where the control sets it (a field, the Save button). Links have the pointer already. A class on an element wins over the rule, as utilities come after the base layer: the status-class and disk bars, which are tooltip triggers that do nothing on a click, keep `cursor-default`.

Other behavior: links and buttons without a ring of their own (a report's text links, a table's sort buttons) get a 2px focus ring in `ring` at once, from a base rule in `globals.css`. shadcn's parts (anything with a `data-slot`) draw their own and are left out. Inside a table that scrolls, and on the product reports' tab links, whose row scrolls, the ring is drawn inward (`outline-offset: -2px`), so the scroller cannot clip it. Status always pairs color with an icon and a label; `prefers-reduced-motion` shortens animations and transitions to near zero; the API status is an `<output>` live region.

Known gaps:

- `ink-tertiary` fails AA for text; use it only for decoration, disabled states, and a chart's de-emphasized part, as the token table says.
- Disabled controls use 50% opacity and fall below 4.5:1, which WCAG allows for inactive components.
- No light theme and no high-contrast theme.
- Overlays (dialog, menu, select, tooltip) were checked by token values, not yet by an automated keyboard or screen reader test.
