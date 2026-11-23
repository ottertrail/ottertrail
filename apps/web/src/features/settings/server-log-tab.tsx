import {
  ArrowDownIcon,
  BugIcon,
  ChevronRightIcon,
  DownloadIcon,
  InfoIcon,
  LoaderCircleIcon,
  PauseIcon,
  PlayIcon,
  ScrollTextIcon,
} from "lucide-react";
import * as React from "react";

import { SettingsSection } from "@/components/settings-section";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { TruncatedText } from "@/components/truncated-text";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useSearchParam } from "@/hooks/use-search-param";
import { cn } from "@/lib/utils";

import { formatPreciseMoment } from "../telemetry/format";
import type { InstanceTabProps } from "./section-states";
import {
  filterLines,
  groupProblems,
  LEVEL_LABELS,
  LEVELS,
  type LevelName,
  type LineFilters,
  missingNote,
  PROCESS_LABELS,
  type ServerLine,
  type ServerProcess,
  toJsonl,
} from "./server-log-lines";
import { type Connection, useServerLog } from "./server-log-stream";

export const SERVER_LOG_TAB = "server-log";

const TONES: Record<LevelName, StatusTone> = {
  debug: "neutral",
  info: "neutral",
  warn: "warning",
  error: "critical",
  fatal: "critical",
};

function LevelBadge({ level }: { level: LevelName }) {
  const icon =
    level === "info" ? (
      <InfoIcon aria-hidden="true" />
    ) : level === "debug" ? (
      <BugIcon aria-hidden="true" />
    ) : undefined;
  return (
    <StatusBadge tone={TONES[level]} icon={icon}>
      {LEVEL_LABELS[level]}
    </StatusBadge>
  );
}

function clockTime(time: number, timeZone: string, withDay: boolean): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    ...(withDay ? { day: "numeric", month: "short" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    ...(withDay ? {} : { fractionalSecondDigits: 3 }),
    hourCycle: "h23",
  }).format(time);
}

function LineTime({
  time,
  timeZone,
  withDay = false,
}: {
  time: number | null;
  timeZone: string;
  withDay?: boolean;
}) {
  if (time === null) return <span className="w-24 shrink-0" />;
  const iso = new Date(time).toISOString();
  return (
    <time
      dateTime={iso}
      title={formatPreciseMoment(iso, timeZone)}
      className="shrink-0 font-mono text-xs leading-5 text-ink-muted tabular-nums"
    >
      {clockTime(time, timeZone, withDay)}
    </time>
  );
}

function requestText(request: NonNullable<ServerLine["request"]>): string {
  const parts = [request.method, request.url];
  if (request.status !== null) parts.push(String(request.status));
  if (request.ms !== null) parts.push(`(${Math.round(request.ms)} ms)`);
  return parts.join(" ");
}

function LineJson({ line, id }: { line: ServerLine; id: string }) {
  return (
    <pre
      id={id}
      className="mx-3 mb-3 max-h-80 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs [overflow-wrap:anywhere] whitespace-pre-wrap text-ink"
    >
      {JSON.stringify({ process: line.process, ...line.raw }, null, 2)}
    </pre>
  );
}

const ROW_BUTTON =
  "flex w-full min-w-0 flex-col gap-1 rounded-lg px-3 py-2 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:flex-row sm:items-center sm:gap-3";

function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronRightIcon
      aria-hidden="true"
      className={cn(
        "size-4 shrink-0 text-ink-subtle transition-transform motion-reduce:transition-none",
        { "rotate-90": open },
      )}
    />
  );
}

function GroupRow({
  count,
  latest,
  timeZone,
}: {
  count: number;
  latest: ServerLine;
  timeZone: string;
}) {
  const [open, setOpen] = React.useState(false);
  const detailId = React.useId();
  const message = latest.msg === "" ? "(no message)" : latest.msg;
  return (
    <li className="rounded-lg ring-1 ring-border">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? detailId : undefined}
        onClick={() => setOpen((value) => !value)}
        className={ROW_BUTTON}
      >
        <span className="flex min-w-0 shrink-0 items-center gap-3">
          <Chevron open={open} />
          <LevelBadge level={latest.level} />
          <span className="w-12 shrink-0 text-xs leading-5 text-ink-subtle">
            {PROCESS_LABELS[latest.process]}
          </span>
        </span>
        <TruncatedText
          text={message}
          className="min-w-0 flex-1 pl-7 font-mono text-xs leading-5 text-ink sm:pl-0"
        />
        <span className="flex shrink-0 items-center gap-3 pl-7 sm:pl-0">
          <span className="text-xs leading-5 text-ink-subtle tabular-nums">
            {count === 1 ? "Once" : `${count.toLocaleString("en-US")} times`}
          </span>
          <span className="sr-only">, latest at</span>
          <LineTime time={latest.time} timeZone={timeZone} withDay />
        </span>
      </button>
      {open && <LineJson line={latest} id={detailId} />}
    </li>
  );
}

const LineRow = React.memo(function LineRow({
  line,
  timeZone,
}: {
  line: ServerLine;
  timeZone: string;
}) {
  const [open, setOpen] = React.useState(false);
  const detailId = React.useId();
  return (
    <li data-line={line.n}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? detailId : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cn(ROW_BUTTON, "py-1")}
      >
        <span className="flex min-w-0 shrink-0 items-center gap-3">
          <Chevron open={open} />
          <LineTime time={line.time} timeZone={timeZone} />
          <span className="w-12 shrink-0 text-xs leading-5 text-ink-subtle">
            {PROCESS_LABELS[line.process]}
          </span>
          {/* Reserve the widest badge's width to align messages. */}
          <span className="flex w-20 shrink-0">
            <LevelBadge level={line.level} />
          </span>
        </span>
        <span className="flex min-w-0 flex-1 flex-col pl-7 sm:flex-row sm:gap-3 sm:pl-0">
          <span className="min-w-0 font-mono text-xs leading-5 [overflow-wrap:anywhere] text-ink">
            {line.msg === "" ? "(no message)" : line.msg}
          </span>
          {line.request !== null && (
            <TruncatedText
              text={requestText(line.request)}
              className="min-w-0 flex-1 font-mono text-xs leading-5 text-ink-subtle"
            />
          )}
        </span>
      </button>
      {open && <LineJson line={line} id={detailId} />}
    </li>
  );
});

function ConnectionLine({
  connection,
  onReconnect,
}: {
  connection: Connection;
  onReconnect: () => void;
}) {
  const { state } = connection;
  const badge =
    state === "live" ? (
      <StatusBadge tone="good">Live</StatusBadge>
    ) : state === "closed" ? (
      <StatusBadge tone="neutral">Closed</StatusBadge>
    ) : (
      <StatusBadge
        tone={state === "reconnecting" ? "warning" : "neutral"}
        icon={
          <LoaderCircleIcon
            aria-hidden="true"
            className="animate-spin motion-reduce:animate-none"
          />
        }
      >
        {state === "reconnecting" ? "Reconnecting" : "Connecting"}
      </StatusBadge>
    );
  const text =
    connection.state === "reconnecting"
      ? `The connection dropped. Trying again in ${connection.inSeconds} ${connection.inSeconds === 1 ? "second" : "seconds"}.`
      : connection.state === "closed"
        ? connection.reason === "busy"
          ? `${connection.maxStreams ?? 5} Server log views are open already, the most the server streams at once. Close one, then reconnect.`
          : connection.reason === "access"
            ? "Your session ended, or you're no longer the owner."
            : "This browser fell behind the log, so the server stopped sending it."
        : null;
  return (
    <output
      aria-label="Connection"
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-subtle"
    >
      {badge}
      {text !== null && (
        <>
          {/* A space the layout drops, so it reads "Closed 5 Server log views …". */}{" "}
          <span className="text-pretty">{text}</span>
        </>
      )}
      {(state === "closed" || state === "reconnecting") && (
        <Button variant="outline" size="sm" onClick={onReconnect}>
          {state === "closed" ? "Reconnect" : "Reconnect now"}
        </Button>
      )}
    </output>
  );
}

function Note({ text }: { text: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-pretty text-ink-subtle">
      <InfoIcon aria-hidden="true" className="size-3.5 shrink-0" />
      {text}
    </p>
  );
}

function Problems({
  lines,
  timeZone,
  apiLevel,
  onShowAll,
}: {
  lines: readonly ServerLine[];
  timeZone: string;
  apiLevel: string | null;
  onShowAll: () => void;
}) {
  const groups = React.useMemo(() => groupProblems(lines), [lines]);
  const note = missingNote(apiLevel, "warn");
  return (
    <div className="flex flex-col gap-3">
      {note !== null && <Note text={note} />}
      {groups.length === 0 ? (
        <Empty className="border border-dashed p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ScrollTextIcon />
            </EmptyMedia>
            <EmptyTitle>No warnings or errors since the API and the worker started</EmptyTitle>
          </EmptyHeader>
          <Button variant="outline" size="sm" onClick={onShowAll}>
            Show all
          </Button>
        </Empty>
      ) : (
        <ul aria-label="Warnings and errors, newest first" className="flex flex-col gap-2">
          {groups.map((group) => (
            <GroupRow
              key={group.key}
              count={group.count}
              latest={group.latest}
              timeZone={timeZone}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

const PROCESS_ITEMS = [
  { value: "all", label: "All processes" },
  { value: "api", label: "API" },
  { value: "worker", label: "Worker" },
];

const LEVEL_ITEMS = LEVELS.map((level) => ({
  value: level,
  label: level === "fatal" ? "Fatal" : `${LEVEL_LABELS[level]} and above`,
}));

const isProcessFilter = (value: unknown): value is ServerProcess | "all" =>
  value === "all" || value === "api" || value === "worker";
const isLevel = (value: unknown): value is LevelName =>
  typeof value === "string" && (LEVELS as readonly string[]).includes(value);

const AT_BOTTOM_PX = 8;

/** Follow arrivals only at the bottom. Pause freezes displayed lines while the stream continues. */
function AllLines({
  lines,
  timeZone,
  apiLevel,
}: {
  lines: readonly ServerLine[];
  timeZone: string;
  apiLevel: string | null;
}) {
  const [filters, setFilters] = React.useState<LineFilters>({
    process: "all",
    level: "info",
    text: "",
  });
  const [held, setHeld] = React.useState<readonly ServerLine[] | null>(null);
  const shown = held ?? lines;
  const visible = React.useMemo(() => filterLines(shown, filters), [shown, filters]);
  const newSincePause =
    held === null ? 0 : lines.filter((line) => line.n > (held.at(-1)?.n ?? 0)).length;
  const boxRef = React.useRef<HTMLDivElement>(null);
  const following = React.useRef(true);
  const [atBottom, setAtBottom] = React.useState(true);

  const toBottom = () => {
    const box = boxRef.current;
    if (box === null) return;
    box.scrollTop = box.scrollHeight;
    following.current = true;
    setAtBottom(true);
  };

  React.useLayoutEffect(() => {
    const box = boxRef.current;
    if (following.current && box !== null) box.scrollTop = box.scrollHeight;
  });

  const note = missingNote(apiLevel, filters.level);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          items={PROCESS_ITEMS}
          value={filters.process}
          onValueChange={(next) => {
            if (isProcessFilter(next)) setFilters((previous) => ({ ...previous, process: next }));
          }}
        >
          <SelectTrigger aria-label="Process" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROCESS_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          items={LEVEL_ITEMS}
          value={filters.level}
          onValueChange={(next) => {
            if (isLevel(next)) setFilters((previous) => ({ ...previous, level: next }));
          }}
        >
          <SelectTrigger aria-label="Level, at or above" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LEVEL_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="search"
          value={filters.text}
          onChange={(event) => {
            const text = event.target.value;
            setFilters((previous) => ({ ...previous, text }));
          }}
          placeholder="Filter lines"
          aria-label="Filter lines"
          autoComplete="off"
          maxLength={200}
          className="w-56 max-w-full"
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => setHeld(held === null ? lines : null)}
          aria-pressed={held !== null}
        >
          {held === null ? <PauseIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}
          {held === null
            ? "Pause"
            : newSincePause > 0
              ? `Resume (${newSincePause.toLocaleString("en-US")} new)`
              : "Resume"}
        </Button>
      </div>
      {note !== null && <Note text={note} />}
      <div className="relative min-w-0">
        <div
          ref={boxRef}
          role="log"
          aria-label="Server log lines, newest at the bottom"
          aria-live="off"
          // A scrolling box takes a tab stop, so the keyboard can scroll it.
          // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          onScroll={(event) => {
            const box = event.currentTarget;
            const bottom = box.scrollHeight - box.scrollTop - box.clientHeight <= AT_BOTTOM_PX;
            following.current = bottom;
            setAtBottom(bottom);
          }}
          className="h-[60vh] min-h-64 overflow-y-auto rounded-lg py-1 ring-1 ring-border focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {visible.length === 0 ? (
            <p className="px-3 py-2 text-sm text-ink-subtle">
              {lines.length === 0 ? "No lines yet." : "No lines match these filters."}
            </p>
          ) : (
            <ol className="flex flex-col">
              {visible.map((line) => (
                <LineRow key={line.n} line={line} timeZone={timeZone} />
              ))}
            </ol>
          )}
        </div>
        {!atBottom && (
          <Button size="sm" className="absolute right-4 bottom-3 shadow-md" onClick={toBottom}>
            <ArrowDownIcon aria-hidden="true" />
            Jump to latest
          </Button>
        )}
      </div>
    </div>
  );
}

function downloadLines(lines: readonly ServerLine[], timeZone: string) {
  const stamp = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(Date.now())
    .replace(" ", "-")
    .replace(":", "");
  const url = URL.createObjectURL(new Blob([toJsonl(lines)], { type: "application/x-ndjson" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `ottertrail-server-log-${stamp}.jsonl`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type View = "problems" | "all";
const isView = (value: unknown): value is View => value === "problems" || value === "all";

/** Stream only while this tab is visible (docs/dashboard.md, "Server log"). */
export function ServerLogTab({ timeZone }: InstanceTabProps) {
  const [tab] = useSearchParam("tab");
  const stream = useServerLog({ enabled: tab === SERVER_LOG_TAB });
  const [view, setView] = React.useState<View>("problems");
  const kept = (stream.maxLines ?? 2000).toLocaleString("en-US");
  return (
    <SettingsSection
      title="Server log"
      description={
        <>
          The API's and the worker's log lines since they last started, up to the latest {kept},
          kept in memory only. For older lines and the databases' logs, run{" "}
          <code className="font-mono">docker compose logs</code> on the server.
        </>
      }
      wide="full"
    >
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <ToggleGroup
            value={[view]}
            onValueChange={(value) => {
              const [next] = value;
              if (isView(next)) setView(next);
            }}
            aria-label="Which lines to show"
            variant="outline"
            size="sm"
            spacing={0}
          >
            <ToggleGroupItem value="problems">Warnings and errors</ToggleGroupItem>
            <ToggleGroupItem value="all">Show all</ToggleGroupItem>
          </ToggleGroup>
          <Button
            variant="outline"
            size="sm"
            disabled={stream.lines.length === 0}
            onClick={() => downloadLines(stream.lines, timeZone)}
          >
            <DownloadIcon aria-hidden="true" />
            Download
          </Button>
          <ConnectionLine connection={stream.connection} onReconnect={stream.reconnect} />
        </div>
        {view === "problems" ? (
          <Problems
            lines={stream.lines}
            timeZone={timeZone}
            apiLevel={stream.apiLevel}
            onShowAll={() => setView("all")}
          />
        ) : (
          <AllLines lines={stream.lines} timeZone={timeZone} apiLevel={stream.apiLevel} />
        )}
      </div>
    </SettingsSection>
  );
}
