# Ottertrail design system

Status: initial foundation. The name treatment and mascot are undecided; the mark in the app is a placeholder.

A dark interface for a dense dashboard: a near-black canvas, a ladder of surfaces instead of shadows, hairline borders, and a single orchid accent used sparingly. This document records the tokens, the reasons behind them, and the remaining gaps.

The live reference page is `/design-system`, "Design system" in the sidebar (`vp run dev`, then open the web URL).

## Where things live

| What                                                                                                           | Where                                  |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Tokens (CSS variables, Tailwind theme, type scale, radius)                                                     | `apps/web/src/styles/globals.css`      |
| shadcn/ui components (Base UI primitives, `base-nova` style)                                                   | `apps/web/src/components/ui/`          |
| Ottertrail components (`StatusBadge`, `ApiStatus`, `TimezoneCombobox`, app shell)                              | `apps/web/src/components/`             |
| Screen blocks (`FilterBar`, `StatStrip`, `BreakdownTable`, `ReportChart`, `ScrollHint`, `Workbench`, settings) | `apps/web/src/components/`             |
| Reference page                                                                                                 | `apps/web/src/features/design-system/` |
| Contrast tests for the tokens                                                                                  | `apps/web/tests/tokens.test.ts`        |
| shadcn configuration                                                                                           | `apps/web/components.json`             |

Use tokens through Tailwind utilities (`bg-card`, `text-ink-subtle`, `ring-border`, `text-headline`), not raw hex values in components.

## Color

Dark only. `index.html` sets `class="dark"` and `color-scheme: dark`; all tokens live in `:root`.

### Neutrals

The greys carry a faint orchid tint (OKLCH hue 325, chroma 0.003 to 0.012), so the neutrals and the accent read as one palette. The tint is too weak to make surfaces look purple, and it does not affect contrast or the chart colors.

| Token               | Value     | Use                                                             |
| ------------------- | --------- | --------------------------------------------------------------- |
| `canvas`            | `#010101` | Page frame and sidebar                                          |
| `surface-1`         | `#110f11` | Main content panel (`background`)                               |
| `surface-2`         | `#161416` | Cards (`card`)                                                  |
| `surface-3`         | `#1a181a` | Popovers, menus, dialogs (`popover`); sidebar active item       |
| `surface-4`         | `#1b191b` | Spare lift step                                                 |
| `hairline`          | `#282328` | Borders, dividers; also the `secondary` and `muted` fills       |
| `hairline-strong`   | `#373338` | Quiet control borders; the wash inside fields (`input-fill`)    |
| `field-edge`        | `#746f75` | Field edges (`input`), switch tracks; 3:1 on fills and surfaces |
| `hairline-tertiary` | `#423d42` | Strongest divider                                               |
| `ink`               | `#f9f7f9` | Primary text (`foreground`)                                     |
| `ink-muted`         | `#dad3da` | Sidebar text, secondary emphasis                                |
| `ink-subtle`        | `#938c93` | Descriptions, placeholders (`muted-foreground`)                 |
| `ink-tertiary`      | `#69646a` | Decorative or disabled only (about 3.2:1, fails AA for text)    |
| `success`           | `#27a644` | Success text and status                                         |

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

`status-good`, `status-warning`, `status-serious` (`#ec835a`), and `status-critical` are reserved for state. Always render them through `StatusBadge` (icon + text label), never as color alone, and never reuse them as chart series colors.

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
- On one page, a color means one thing. When a page's charts show different entities, such as status classes and percentiles, each takes slots no other on the page uses: a service's page gives the classes `chart-1` to `chart-4`, the failed share `chart-5`, and the percentiles `chart-6` to `chart-8`; a query shape's page keeps the same slots, its calls taking `chart-1`.
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
- Added with that CLI: Radio Group, Toggle Group (with Toggle), Resizable and Popover, shown on the reference page.
- Local changes to generated files: the `text-link` substitutions above; `hooks/use-mobile.ts` rewritten with `useSyncExternalStore` (the generated version set state inside an effect); `select.tsx`, whose list opens below its trigger, aligned to its start (`alignItemWithTrigger = false`, `align = "start"`), where Base UI's default lays the list over the trigger so that the chosen item sits on it, which covered the controls above (the tabs over a page's period filter); and these, from the redesign's first phase:
  - **Field washes:** `bg-input/…` became `bg-input-fill/…` (input, textarea, select, combobox, checkbox, radio group, tabs, button), because `input` is now the 3:1 field edge; the outline button's and the active tab's border became `border-hairline-strong`, so they stay quiet. Error borders are full `border-destructive`, not `/50`, which fell to 2.5:1 (combobox included).
  - **Switch track:** the unchecked track is `bg-input` at full strength, not `/80`: the track is the switch's boundary, so it takes the field edge, 3.6 to 3.9:1 on the surfaces, with the thumb (`foreground`) 4.6:1 on it.
  - **No `transition-all`:** badge, button, switch, tabs and toggle use `transition-colors`. The sidebar no longer animates its width, position or padding (the gap, the container, the menu buttons), and its group label fades without moving its margin: Hallmark's Floor bans animating size and position.
  - **The sidebar's breakpoint:** its `md:` classes became `min-[60rem]:`, with `hooks/use-mobile.ts` matching `(width < 60rem)`, so the sheet takes over under 60rem. The sheet's title is "Menu".
  - **Overlays:** the dialog and sheet backdrops are `bg-canvas/70` without the backdrop blur.
  - **Dropdown shortcuts** are untracked (`tracking-widest` removed).

  Keep these when updating components.

- Use a shadcn component wherever one exists for the job (a radio group, a toggle group, tabs, a popover, a sheet, a dialog, a table), added with the CLI below, rather than a hand-built control; build one by hand only when shadcn has none, in the generated files' style, as `combobox.tsx` is.
- The root lint config relaxes five rules for `components/ui/*.tsx` only, so upstream updates stay reviewable.
- A link that looks like a button is `ButtonLink` (`components/button-link.ts`), which takes the router's link props. Do not render a `Button` as a link (`render={<Link />}`): Base UI gives the rendered element the button role, so screen readers announce the link as a button.
- A text field that filters a long list of choices is `Combobox` (`components/ui/combobox.tsx`, written by hand in the generated files' style, on Base UI's Combobox, which gives it the `combobox`, `listbox`, and `option` roles and the keyboard: arrows, Enter, Escape). `ComboboxInput` is the field, styled like `Input`, with a button that opens the list; its other props go to the `<input>`, so a `<label htmlFor>` names it. `ComboboxContent` is the floating list on `popover`, as wide as the field and at most 18rem high, scrolling inside; `ComboboxItem` marks the chosen option with a check; `ComboboxEmpty` says when nothing matches and stays mounted as a live region. Use it instead of an `<input list>` with a `<datalist>`, which browsers show as an unstyled native list. The timezone fields use it through `TimezoneCombobox` (`components/timezone-combobox.tsx`). A `datalist` stays only where any value may be typed past the suggestions, such as the alert rules' and the funnel editor's fields.
- Text to copy, such as an install snippet or a key, is `CopyableCode` (`components/copyable-code.tsx`): code that wraps, with its copy button inside the box. Never a read-only input, which looks editable, and never inside a form whose Save button would not store it.

### Data states

Every region that loads data needs four states, shown on the reference page:

- **Loading:** skeletons shaped like the content they replace.
- **Empty:** say why there is no data and what to do next.
- **Failure:** say what failed and offer a retry. Never show stale data as current.
- **Delayed data:** use a `warning` `StatusBadge` with a label that names the delay. No component exists for this yet.

Plus the full state. A region that refreshes keeps its last data, dimmed, and says when a refresh failed; it never shows it as current.

## Screen patterns

Every screen takes one of three patterns, by what it is for. The blocks live in `apps/web/src/components/`, each with its states on the reference page under "Screen patterns". The approved mockups behind them were the Console (reports) and Workbench (lists and settings) directions.

| Kind of screen   | Pattern           | Screens                                                                                |
| ---------------- | ----------------- | -------------------------------------------------------------------------------------- |
| Report           | Console           | Overview, Web analytics, Speed, Product analytics, Services, Databases, Hosts, Metrics |
| List with detail | Workbench         | Errors, Replays, Traces, Logs, Users, Uptime, Alerts                                   |
| Settings         | Tabs and Save bar | Project settings, instance Settings, Members                                           |

### The shell

- The sidebar is expanded on every screen, on `canvas`, with the main panel inset beside it (`surface-1`, a hairline ring). Ctrl B (⌘ B on a Mac) or the header's button collapses it to icons; `lib/sidebar-state.ts` remembers the choice in `localStorage` (`ottertrail.sidebar`). The header shows the shortcut.
- Under 60rem the sidebar is shadcn's sheet: the header's first button becomes "Open menu", and choosing a link closes the sheet (`app.tsx`).
- The header holds the menu button, the breadcrumb (the project, then the page title as the page's `h1`) and the shortcut hint.
- Page content sits inside `px-gutter`: 24px, 16px under 40rem. Nothing scrolls sideways at 320 to 1920 except a table inside its own container.

### Report (Console)

A report reads top to bottom, with no cards around its parts; hairline rules and spacing separate them.

1. **`FilterBar`** (`filter-bar.tsx`): a `<search>` landmark pinned under the header (from 40rem; on a phone it scrolls away). Slots, in order: `period` (a Select), `environment` (only when there is a choice), `filters` (active filters, or a Toggle Group such as Unresolved, Resolved, All), and at the end `range` and `actions`. It wraps on narrow screens. `FilterBarRange` writes the days and the timezone as two items.
2. **`StatStrip`** (`stat-strip.tsx`): the figures in one row, parted by hairlines, as a `<dl>`: a label, the figure in tabular numerals, and optionally its change from the period before (an arrow and a size, read out as a sentence such as "Up 12% from 683"). A stat's `counts` are what its change rests on: its own count in this period and the one before (for a share, the counts it is taken of). With a `minCount`, the change shows only when the larger of the two reaches it, because a few visits make any percentage look large; with no `counts`, it is left out. When the period before had none, a stat that reaches the minimum reads "New" instead of a percentage. One rule for every figure: `shownChange` in `lib/change.ts`; a report whose API gives no period before (Speed, an event, a service, a query shape) shows no change. A stat's optional `detail` goes under its figure, in small text: a rating badge, a spread, how many loads it was measured on (the Core Web Vitals on the Speed page). Labels wrap rather than cut off. Two columns on a phone, four up to 64rem, one row above; a page passes `className` for another count (three on the Speed page, one column on a phone for the vitals). No icon tiles and no trend nobody measured.
3. **A short chart**, wide and low, per the chart rules above: `ReportChart` (`report-chart.tsx`) is one chart's section, a hairline above, its title with "Show the numbers" beside it (and any toggle, through `actions`), a line on what it draws, the chart, and its table view under it once asked for. The plot is 140px high (`plotHeight` on `DayChart` and `TimeChart`). The telemetry pages draw theirs with `ChartSection` (`features/telemetry/chart-card.tsx`), full width, one under another; `ChartCard` stays for charts in a card (an uptime check's page).
4. **`BreakdownTable`** (`breakdown-table.tsx`), two or three side by side from 64rem: a compact `ui/table` with the name, an inline bar in proportion to the largest row (`chart-1`, one baseline), and the figures right-aligned in tabular numerals. A Toggle Group in its header (`views`; buttons with `aria-pressed`, named "Which pages to list") switches the one table between lists of one kind (Top pages, Entry, Exit): not tabs, which would promise a panel per tab; `showAll` holds the "Show all" control; `empty` says why there are no rows. On phones the table either scrolls inside itself with the name column pinned (`layout="scroll"`, the default) or stacks each row into a block, the name over its bar and the figures labelled (`layout="stack"`). Inside a card, set `--block-surface` to `var(--card)` so the pinned column matches. With more than two figures (the Speed page's loads, LCP, INP, and CLS), the figure columns are 5rem and the name takes what is left, so the table fits half the content's width. `description` puts a line under the title ("On 140 events"). A scrolling table carries the scroll hint.
5. **Wider tables** (a service's routes, a database's query shapes, hosts, metrics) are `ui/table`s with small untracked heads, inside `ScrollHint` (`scroll-hint.tsx`): on a phone the table scrolls inside itself, its first column pinned (`PINNED`, `pinned-column.ts`) and, when the last column holds the row's actions (open its trace, add an alert rule), that one pinned at the other edge (`PINNED_END`); a fade at the edge says more columns wait, drawn just inside a column pinned at the end, above the cells that scroll under it. Both pinned columns are opaque, and a marked row (`aria-current`) keeps its highlight on them. A first column too wide to pin beside the actions (a call's start time) scrolls instead. At 1440 they fit without scrolling.
6. **Side by side by the container.** Blocks that sit side by side do so by the content's width (`@container`, `@3xl`, `@5xl`), not the window's, since the sidebar takes 16rem: two tables of the Speed page or a query shape's page side by side from 64rem of content.

A report's detail page (an event, a service, a query shape, a host, a metric) keeps the same order: the filter bar, then a link back to its list and its name as the page's second heading, its strip of figures, its charts, its tables. `ReportFilterBar` (`features/errors/range-controls.tsx`) is the filter bar with the period, the environment, and the days filled in; a page adds its own filters (a device, an event's property filters, a metric's split, measure, and narrowing).

### Workbench

A list on the left and the selected item on the right (`workbench.tsx`), on shadcn's Resizable (the list starts at 40%, 25 to 65%).

- **The selection is in the address** (`param`, such as `?error=<fingerprint>`), through TanStack Router (`hooks/use-search-param.ts`), so it survives a reload. A click adds a history entry; `j`, `k` and `Esc` replace it, so Back returns to where the list was opened rather than through every step.
- **Nothing is selected on arrival.** The detail pane shows `summary`: the list summed up (counts, what needs attention), or with an empty list, how to start.
- **Keys:** `j` and `k` select the next and previous item (`j` with nothing selected takes the first), `Esc` clears the selection, and one `action` key acts on the selected item (`e` resolves or reopens an error). They do nothing while focus is in a text field, an open list, a menu or a dialog (`lib/keys.ts`); a closed Select is a button, and the keys work after choosing in it. `WorkbenchKeyHints` lists them in the filter bar, from 64rem.
- **Focus** follows `j` and `k` to the chosen row, and moves to it when an item is chosen from inside the detail pane (a name in the summary), whose content then goes. When an action takes the selected item out of the list (resolving an error under Unresolved), `j` and `k` carry on from its last place. When the selection clears (`Esc`, Back) with focus in the detail, focus returns to the row that was chosen, or the list.
- **Rows** carry `data-workbench-id`, so the selection scrolls into view, and mark the chosen row with `aria-current` on its link or button and `data-state="selected"` (a 2px `brand` rule at its start). Row controls stay on one line and truncate, with the whole text in `title`.
- **Under 64rem** the list fills the screen and choosing an item calls `onOpenPage`, which goes to the item's own page. An address with a selection, opened on a narrow screen, does the same once: the list's entry loses the selection first, so Back returns to the list. A window that narrows during a session (a zoom) leaves the list where it is. Every item keeps its full page.
- A list's quick actions (an alert rule's on or off) stay instant, on the row.

### Settings tabs and the Save bar

- **`SettingsTabs`** (`settings-tabs.tsx`): the page's sections as line tabs, the chosen one in the address (`?tab=<value>`; the first tab is the default and leaves it out). Every panel stays mounted, so edits in one tab survive a visit to another, and a tab with unsaved changes shows an "Unsaved" badge after its label, read as "Settings, unsaved changes". The tab row scrolls sideways on a phone rather than wrapping.
- **`SettingsSection`** (`settings-section.tsx`): one titled section. With a `form` (from `useDirtyForm`) it is a `<form>` with its own **Save bar**, sticky at the foot of the screen while the form is in view: an `<output>` that says "No unsaved changes" or "Unsaved changes", Discard while there is a change, and Save. Save stays focusable while disabled (`aria-disabled`, Base UI's `focusableWhenDisabled`), so focus never drops to the page during or after a save; it still looks disabled (50% and the not-allowed cursor, styled on `aria-disabled`). Without a `form` (an install snippet, a key, a danger zone) it has no Save bar.
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

### Responsive rules

Two breakpoints, in rem so they follow the reader's font size, with one more for the workbench:

| Width       | What changes                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| under 40rem | Gutters 16px. The filter bar scrolls away instead of sticking. Breakdown tables scroll inside themselves or stack. Stat strips take two columns. |
| under 60rem | The sidebar is a sheet behind the header's menu button. Multi-column layouts go to one column.                                                   |
| under 64rem | A workbench shows its list alone; an item opens its own page. Breakdown tables stop sitting side by side.                                        |

Hooks: `useMediaQuery` with `NARROW_SHELL` and `NARROW_WORKBENCH` (`hooks/use-media-query.ts`); in classes, `sm:` (40rem), `min-[60rem]:` and `min-[64rem]:` or `lg:` (64rem). Every screen is tested at 390 and 1440 wide. Controls are 32 to 40px high with a 44px hit area on a phone, and never wrap their labels.

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

Other behavior: links and buttons without a ring of their own (a report's text links, a table's sort buttons) get a 2px focus ring in `ring` at once, from a base rule in `globals.css`. shadcn's parts (anything with a `data-slot`) draw their own and are left out. Inside a table that scrolls, and on the product reports' tab links, whose row scrolls, the ring is drawn inward (`outline-offset: -2px`), so the scroller cannot clip it. Status always pairs color with an icon and a label; `prefers-reduced-motion` shortens animations and transitions to near zero; the API status is an `<output>` live region.

Known gaps:

- `ink-tertiary` fails AA for text; use it only for decoration or disabled states.
- Disabled controls use 50% opacity and fall below 4.5:1, which WCAG allows for inactive components.
- No light theme and no high-contrast theme.
- Overlays (dialog, menu, select, tooltip) were checked by token values, not yet by an automated keyboard or screen reader test.
