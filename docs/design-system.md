# Ottertrail design system

Status: initial foundation. The name treatment and mascot are undecided; the mark in the app is a placeholder.

A dark interface for a dense dashboard: a near-black canvas, a ladder of surfaces instead of shadows, hairline borders, and a single orchid accent used sparingly. This document records the tokens, the reasons behind them, and the remaining gaps.

The live reference page is the app's home screen (`vp run dev`, then open the web URL).

## Where things live

| What                                                          | Where                                  |
| ------------------------------------------------------------- | -------------------------------------- |
| Tokens (CSS variables, Tailwind theme, type scale, radius)    | `apps/web/src/styles/globals.css`      |
| shadcn/ui components (Base UI primitives, `base-nova` style)  | `apps/web/src/components/ui/`          |
| Ottertrail components (`StatusBadge`, `ApiStatus`, app shell) | `apps/web/src/components/`             |
| Reference page                                                | `apps/web/src/features/design-system/` |
| Contrast tests for the tokens                                 | `apps/web/tests/tokens.test.ts`        |
| shadcn configuration                                          | `apps/web/components.json`             |

Use tokens through Tailwind utilities (`bg-card`, `text-ink-subtle`, `ring-border`, `text-headline`), not raw hex values in components.

## Color

Dark only. `index.html` sets `class="dark"` and `color-scheme: dark`; all tokens live in `:root`.

### Neutrals

The greys carry a faint orchid tint (OKLCH hue 325, chroma 0.003 to 0.012), so the neutrals and the accent read as one palette. The tint is too weak to make surfaces look purple, and it does not affect contrast or the chart colors.

| Token               | Value     | Use                                                          |
| ------------------- | --------- | ------------------------------------------------------------ |
| `canvas`            | `#010101` | Page frame and sidebar                                       |
| `surface-1`         | `#110f11` | Main content panel (`background`)                            |
| `surface-2`         | `#161416` | Cards (`card`)                                               |
| `surface-3`         | `#1a181a` | Popovers, menus, dialogs (`popover`); sidebar active item    |
| `surface-4`         | `#1b191b` | Spare lift step                                              |
| `hairline`          | `#282328` | Borders, dividers; also the `secondary` and `muted` fills    |
| `hairline-strong`   | `#373338` | Input borders (`input`)                                      |
| `hairline-tertiary` | `#423d42` | Strongest divider                                            |
| `ink`               | `#f9f7f9` | Primary text (`foreground`)                                  |
| `ink-muted`         | `#dad3da` | Sidebar text, secondary emphasis                             |
| `ink-subtle`        | `#938c93` | Descriptions, placeholders (`muted-foreground`)              |
| `ink-tertiary`      | `#69646a` | Decorative or disabled only (about 3.2:1, fails AA for text) |
| `success`           | `#27a644` | Success text and status                                      |

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
| `text-eyebrow`                 | 13px / 1.30 / +0.4px / 500             |
| `text-code` (with `font-mono`) | 13px / 1.50 / 0 / 400                  |

The dashboard is dense: controls and body copy use shadcn's `text-sm` (14px) and `text-xs` (12px). Display sizes are for page titles and empty marketing-like moments, not for data screens.

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
- Add components from `apps/web`: `pnpm dlx shadcn@latest add <name>`, then run `vp check --fix` from the repository root to apply formatting.
- Local changes to generated files: the `text-link` substitutions above, and `hooks/use-mobile.ts` rewritten with `useSyncExternalStore` (the generated version set state inside an effect). Keep these when updating components.
- The root lint config relaxes five rules for `components/ui/*.tsx` only, so upstream updates stay reviewable.
- A link that looks like a button is `ButtonLink` (`components/button-link.ts`), which takes the router's link props. Do not render a `Button` as a link (`render={<Link />}`): Base UI gives the rendered element the button role, so screen readers announce the link as a button.
- Text to copy, such as an install snippet or a key, is `CopyableCode` (`components/copyable-code.tsx`): code that wraps, with its copy button inside the box. Never a read-only input, which looks editable, and never inside a form whose Save button would not store it.

### Data states

Every report needs four states, shown on the reference page:

- **Loading:** skeletons shaped like the content they replace.
- **Empty:** say why there is no data and what to do next.
- **Failure:** say what failed and offer a retry. Never show stale data as current.
- **Delayed data:** use a `warning` `StatusBadge` with a label that names the delay. No component exists for this yet.

## Accessibility

`apps/web/tests/tokens.test.ts` enforces these guarantees on every test run:

- Text tokens (`foreground`, `ink-muted`, `muted-foreground`, `link`, `destructive`, `success`, `warning`) are at least 4.5:1 on `background`, `card`, and `popover`.
- Foreground/background pairs for primary, secondary, muted, sidebar, and sidebar-accent are at least 4.5:1.
- Status text on its own tint (badges) is at least 4.5:1.
- The focus ring and every chart and status mark are at least 3:1 on their surfaces.

Other behavior: status always pairs color with an icon and a label; `prefers-reduced-motion` shortens animations and transitions to near zero; the API status is an `<output>` live region.

Known gaps:

- **Input borders** (`#373338`) are about 1.5:1 against the surfaces, below the WCAG 1.4.11 3:1 target for component boundaries. The low contrast is deliberate, to keep forms quiet. Inputs always have a visible label and a filled background; revisit if testing with users shows controls are hard to find.
- `ink-tertiary` fails AA for text; use it only for decoration or disabled states.
- Disabled controls use 50% opacity and fall below 4.5:1, which WCAG allows for inactive components.
- No light theme and no high-contrast theme.
- Overlays (dialog, menu, select, tooltip) were checked by token values, not yet by an automated keyboard or screen reader test.
