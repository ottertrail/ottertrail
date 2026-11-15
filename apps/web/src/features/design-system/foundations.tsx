import { StatusBadge, type StatusTone } from "@/components/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { Section, Specimen } from "./section";

/** Reads the computed value of a CSS custom property defined in globals.css. */
function readToken(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
}

interface SwatchProps {
  token: string;
  label?: string;
}

function Swatch({ token, label }: SwatchProps) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div
        className="h-14 rounded-lg ring-1 ring-hairline-strong ring-inset"
        style={{ backgroundColor: `var(--${token})` }}
      />
      <div className="space-y-0.5">
        <p className="text-sm font-medium text-ink">{label ?? token}</p>
        <p className="truncate font-mono text-code text-ink-subtle">
          --{token} · {readToken(token)}
        </p>
      </div>
    </div>
  );
}

const swatchGrid = "grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] items-start gap-4";

const colorGroups = [
  {
    title: "Surface ladder: hierarchy comes from lift, not shadows",
    tokens: ["canvas", "surface-1", "surface-2", "surface-3", "surface-4"],
  },
  { title: "Hairlines", tokens: ["hairline", "hairline-strong", "hairline-tertiary"] },
  { title: "Ink", tokens: ["ink", "ink-muted", "ink-subtle", "ink-tertiary"] },
  {
    title: "Accent: brand mark, primary action, focus ring, links",
    tokens: ["brand", "brand-focus", "link"],
  },
  { title: "Feedback", tokens: ["success", "warning", "danger"] },
];

const chartSeries = [
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "chart-6",
  "chart-7",
  "chart-8",
];

const statuses: { tone: StatusTone; label: string; token: string }[] = [
  { tone: "good", label: "Healthy", token: "status-good" },
  { tone: "warning", label: "Delayed", token: "status-warning" },
  { tone: "critical", label: "Failing", token: "status-critical" },
  { tone: "neutral", label: "Unknown", token: "muted-foreground" },
];

export function ColorSection() {
  return (
    <Section
      id="color"
      eyebrow="Foundations"
      title="Color"
      description="Dark only. A near-black canvas, a four-step surface ladder, hairline borders, and a single orchid accent used for the brand mark, the primary action, focus rings, and links."
    >
      <div className="space-y-4">
        {colorGroups.map((group) => (
          <Specimen key={group.title} title={group.title} className={swatchGrid}>
            {group.tokens.map((token) => (
              <Swatch key={token} token={token} />
            ))}
          </Specimen>
        ))}

        <Specimen
          title="Chart series: assign in this order, never cycle; more than 8 series fold into Other"
          className={swatchGrid}
        >
          {chartSeries.map((token, index) => (
            <Swatch key={token} token={token} label={`Series ${index + 1}`} />
          ))}
        </Specimen>

        <Specimen title="Status: reserved for state; always icon + label, never color alone">
          {statuses.map((status) => (
            <StatusBadge key={status.tone} tone={status.tone}>
              {status.label}
            </StatusBadge>
          ))}
        </Specimen>
      </div>
    </Section>
  );
}

const typeScale = [
  { token: "display-xl", className: "text-display-xl", spec: "80 / 1.05 / -3px / 600" },
  { token: "display-lg", className: "text-display-lg", spec: "56 / 1.10 / -1.8px / 600" },
  { token: "display-md", className: "text-display-md", spec: "40 / 1.15 / -1px / 600" },
  { token: "headline", className: "text-headline", spec: "28 / 1.20 / -0.6px / 600" },
  { token: "card-title", className: "text-card-title", spec: "22 / 1.25 / -0.4px / 500" },
  { token: "subhead", className: "text-subhead", spec: "20 / 1.40 / -0.2px / 400" },
  { token: "body-lg", className: "text-body-lg", spec: "18 / 1.50 / -0.1px / 400" },
  { token: "body", className: "text-body", spec: "16 / 1.50 / -0.05px / 400" },
  { token: "body-sm", className: "text-body-sm", spec: "14 / 1.50 / 0 / 400" },
  { token: "caption", className: "text-caption", spec: "12 / 1.40 / 0 / 400" },
  { token: "eyebrow", className: "text-eyebrow", spec: "13 / 1.30 / +0.4px / 500" },
  { token: "code", className: "font-mono text-code", spec: "13 / 1.50 / 0 / 400, mono" },
];

export function TypographySection() {
  return (
    <Section
      id="typography"
      eyebrow="Foundations"
      title="Typography"
      description="Inter Variable with optical sizing, and JetBrains Mono for code. Display sizes use strong negative tracking; dense dashboard UI uses 14px and 12px text."
    >
      <div className="overflow-hidden rounded-xl bg-card ring-1 ring-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-36 pl-4">Token</TableHead>
              <TableHead className="w-56">Size / line / tracking / weight</TableHead>
              <TableHead>Sample</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {typeScale.map((style) => (
              <TableRow key={style.token}>
                <TableCell className="pl-4 font-mono text-code text-ink-muted">
                  {style.token}
                </TableCell>
                <TableCell className="font-mono text-code text-ink-subtle">{style.spec}</TableCell>
                <TableCell className="max-w-0 overflow-hidden">
                  <span className={`block truncate text-ink ${style.className}`}>
                    Follow the trail
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Section>
  );
}

const radii = [
  {
    utility: "rounded-sm",
    px: "4px",
    className: "rounded-sm",
    use: "Tags, small chips",
  },
  {
    utility: "rounded-md",
    px: "6px",
    className: "rounded-md",
    use: "Menu items, tab triggers",
  },
  {
    utility: "rounded-lg",
    px: "8px",
    className: "rounded-lg",
    use: "Buttons, inputs",
  },
  {
    utility: "rounded-xl",
    px: "12px",
    className: "rounded-xl",
    use: "Cards, dialogs",
  },
  {
    utility: "rounded-2xl",
    px: "16px",
    className: "rounded-2xl",
    use: "Screenshot panels",
  },
  { utility: "rounded-4xl", px: "9999px", className: "rounded-4xl", use: "Badges" },
];

export function ShapeSection() {
  return (
    <Section
      id="shape"
      eyebrow="Foundations"
      title="Shape and spacing"
      description="Spacing uses Tailwind's 4px scale. The radius scale is set so shadcn's component classes produce these values without local edits."
    >
      <Specimen title="Radius" className={swatchGrid}>
        {radii.map((radius) => (
          <div key={radius.utility} className="flex min-w-0 flex-col gap-2">
            <div
              className={`h-14 border border-hairline-strong bg-surface-3 ${radius.className}`}
            />
            <div className="space-y-0.5">
              <p className="font-mono text-code text-ink">{radius.utility}</p>
              <p className="text-caption text-ink-subtle">
                {radius.px} · {radius.use}
              </p>
            </div>
          </div>
        ))}
      </Specimen>
    </Section>
  );
}
