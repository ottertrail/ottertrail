import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookmarkIcon, CheckIcon, LoaderCircleIcon, OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { TruncatedText } from "@/components/truncated-text";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Field,
  FieldContent,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { Filters } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import {
  createSegment,
  deleteSegment,
  matchesSegment,
  MAX_PERSONAL_SEGMENTS,
  MAX_PROJECT_SEGMENTS,
  type Segment,
  segmentFailure,
  segmentFilters,
  segmentNameProblem,
  segmentsKey,
  segmentsQuery,
  updateSegment,
  type Visibility,
} from "@/lib/segments-api";

import { chipText, type PageSearch } from "./list-rows";
import { useAnalyticsScope } from "./scope";

/*
 * The filter bar's Segments menu (docs/dashboard.md, "Segments"): saved
 * sets of filters, the project's and the user's own. Applying one replaces
 * the filters and keeps the period, environment, and goal. Only the
 * dashboard's scope draws it, so a shared link never loads it.
 */

const LIMITS: Record<Visibility, number> = {
  project: MAX_PROJECT_SEGMENTS,
  personal: MAX_PERSONAL_SEGMENTS,
};

const VISIBILITY_LABELS: Record<Visibility, string> = {
  project: "Project",
  personal: "Only you",
};

const filtersText = (filters: Filters) => filters.map(chipText).join("; ");

const INVALID_TEXT =
  "It uses a filter or value the page no longer takes, so it cannot be applied. Save the current filters over it, or delete it.";

/** Put a changed segment in the cached list at once, then read the list again. */
function remember(queryClient: QueryClient, projectId: string, change: Segment | { gone: string }) {
  queryClient.setQueryData<Segment[]>(segmentsKey(projectId), (list) => {
    if (list === undefined) return undefined;
    const others = list.filter((item) => item.id !== ("gone" in change ? change.gone : change.id));
    return ("gone" in change ? others : [...others, change]).toSorted((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    );
  });
  void queryClient.invalidateQueries({ queryKey: segmentsKey(projectId) });
}

export function SegmentsMenu({
  projectId,
  search,
  canManageProject,
}: {
  projectId: string;
  search: PageSearch;
  /** The projects permission: saving, renaming, and deleting the project's segments. */
  canManageProject: boolean;
}) {
  const scope = useAnalyticsScope();
  const segments = useQuery(segmentsQuery(projectId));
  const [dialog, setDialog] = React.useState<"save" | "manage" | null>(null);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const list = segments.data ?? [];
  const active = list.filter((segment) => matchesSegment(search.filters, segment));
  const [first] = active;
  const groups = [
    { label: "Project segments", items: list.filter((item) => item.visibility === "project") },
    { label: "Your segments", items: list.filter((item) => item.visibility === "personal") },
  ].filter((group) => group.items.length > 0);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              ref={trigger}
              variant="outline"
              className="max-w-64"
              aria-label={first === undefined ? undefined : `Segments, ${first.name} applied`}
            />
          }
        >
          <BookmarkIcon data-icon="inline-start" />
          {first === undefined ? "Segments" : <TruncatedText text={first.name} />}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-auto max-w-[min(20rem,calc(100vw-2rem))] min-w-56"
        >
          {segments.isPending && <DropdownMenuItem disabled>Loading segments…</DropdownMenuItem>}
          {segments.isError && (
            <DropdownMenuItem onClick={() => void segments.refetch()}>
              <OctagonAlertIcon aria-hidden="true" />
              Segments could not load. Retry
            </DropdownMenuItem>
          )}
          {segments.isSuccess && list.length === 0 && (
            <p className="px-2 py-1.5 text-sm text-ink-subtle">No saved segments yet.</p>
          )}
          {groups.map((group) => (
            <DropdownMenuGroup key={group.label}>
              <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
              {group.items.map((segment) => {
                const filters = segmentFilters(segment);
                const isActive = active.includes(segment);
                return (
                  <DropdownMenuItem
                    key={segment.id}
                    disabled={filters === null}
                    aria-current={isActive || undefined}
                    onClick={() => {
                      if (filters !== null) scope.show({ ...search, filters });
                    }}
                  >
                    <CheckIcon aria-hidden="true" className={isActive ? undefined : "invisible"} />
                    <span className="min-w-0 flex-1 truncate">{segment.name}</span>
                    {filters === null && <Badge variant="outline">Invalid</Badge>}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={search.filters.length === 0}
            onClick={() => setDialog("save")}
          >
            Save current filters…
          </DropdownMenuItem>
          {list.length > 0 && (
            <DropdownMenuItem onClick={() => setDialog("manage")}>
              Manage segments…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={dialog === "save"} onOpenChange={(open) => setDialog(open ? "save" : null)}>
        <DialogContent className="sm:max-w-md" finalFocus={trigger}>
          {dialog === "save" && (
            <SaveSegmentForm
              projectId={projectId}
              filters={search.filters}
              segments={list}
              canManageProject={canManageProject}
              onSaved={() => setDialog(null)}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={dialog === "manage"} onOpenChange={(open) => setDialog(open ? "manage" : null)}>
        <DialogContent className="sm:max-w-xl" finalFocus={trigger}>
          <DialogHeader>
            <DialogTitle>Segments</DialogTitle>
            <DialogDescription>
              Project segments show to everyone who reads this project's Web analytics.
              {canManageProject ? "" : " Only the owner and admins change them."}
            </DialogDescription>
          </DialogHeader>
          <ul
            aria-label="Saved segments"
            className="flex max-h-[60vh] flex-col divide-y divide-hairline overflow-y-auto"
          >
            {list.map((segment) => (
              <SegmentRow
                key={segment.id}
                projectId={projectId}
                segment={segment}
                current={search.filters}
                canChange={segment.visibility === "personal" || canManageProject}
              />
            ))}
          </ul>
          {list.length === 0 && <p className="text-ink-subtle">No saved segments.</p>}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The name field of the save and rename forms, with the API's name rules. */
function NameField({
  name,
  onName,
  error,
}: {
  name: string;
  onName: (name: string) => void;
  error: string | null;
}) {
  const id = React.useId();
  return (
    <Field data-invalid={error !== null || undefined}>
      <FieldLabel htmlFor={id}>Name</FieldLabel>
      <Input
        id={id}
        value={name}
        placeholder="Blog readers in Germany"
        autoComplete="off"
        aria-invalid={error !== null || undefined}
        aria-describedby={error === null ? undefined : `${id}-error`}
        onChange={(event) => onName(event.target.value)}
      />
      {error !== null && <FieldError id={`${id}-error`}>{error}</FieldError>}
    </Field>
  );
}

const nameTakenError = (error: Error | null) =>
  error instanceof ApiError && error.code === "segment_name_taken" ? error : null;

function SaveSegmentForm({
  projectId,
  filters,
  segments,
  canManageProject,
  onSaved,
}: {
  projectId: string;
  filters: Filters;
  segments: readonly Segment[];
  canManageProject: boolean;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const id = React.useId();
  const [name, setName] = React.useState("");
  const [visibility, setVisibility] = React.useState<Visibility>("personal");
  const [checked, setChecked] = React.useState(false);
  const save = useMutation({
    mutationFn: () => createSegment(projectId, visibility, name, filters),
    onSuccess: (segment) => {
      remember(queryClient, projectId, segment);
      onSaved();
    },
  });
  const atLimit =
    segments.filter((segment) => segment.visibility === visibility).length >= LIMITS[visibility];
  const problem = segmentNameProblem(name);
  const taken = nameTakenError(save.error);
  const nameError = (checked ? problem : null) ?? taken?.message ?? null;
  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setChecked(true);
        if (problem === null && !atLimit && !save.isPending) save.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>Save the filters as a segment</DialogTitle>
        <DialogDescription>
          A segment keeps the filters only. The period, environment, and goal stay as you choose
          them.
        </DialogDescription>
      </DialogHeader>
      <NameField
        name={name}
        onName={(next) => {
          setName(next);
          if (taken !== null) save.reset();
        }}
        error={nameError}
      />
      <p className="text-sm break-words text-ink-subtle">{filtersText(filters)}</p>
      {canManageProject && (
        <FieldSet>
          <FieldLegend variant="label">Who sees it</FieldLegend>
          <RadioGroup
            value={visibility}
            onValueChange={(value) => {
              if (value === "personal" || value === "project") {
                setVisibility(value);
                save.reset();
              }
            }}
          >
            {(["personal", "project"] as const).map((value) => (
              <Field key={value} orientation="horizontal">
                <RadioGroupItem value={value} id={`${id}-${value}`} />
                <FieldContent>
                  <FieldLabel htmlFor={`${id}-${value}`} className="font-normal">
                    {value === "personal" ? "Only you" : "Everyone in the project"}
                  </FieldLabel>
                </FieldContent>
              </Field>
            ))}
          </RadioGroup>
        </FieldSet>
      )}
      {atLimit && (
        <Alert role="alert">
          <OctagonAlertIcon />
          <AlertDescription>
            {visibility === "project"
              ? `A project has at most ${MAX_PROJECT_SEGMENTS} segments.`
              : `You have at most ${MAX_PERSONAL_SEGMENTS} segments of your own here.`}{" "}
            Delete one to save another.
          </AlertDescription>
        </Alert>
      )}
      {save.error !== null && taken === null && (
        <Alert variant="destructive" role="alert">
          <OctagonAlertIcon />
          <AlertDescription>{segmentFailure(save.error)}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
        <Button type="submit" disabled={save.isPending || atLimit}>
          {save.isPending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
          Save segment
        </Button>
      </DialogFooter>
    </form>
  );
}

/** One saved segment in Manage segments, with what the user may do to it. */
function SegmentRow({
  projectId,
  segment,
  current,
  canChange,
}: {
  projectId: string;
  segment: Segment;
  current: Filters;
  canChange: boolean;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState<"rename" | "delete" | null>(null);
  const filters = segmentFilters(segment);
  const onError = () => void queryClient.invalidateQueries({ queryKey: segmentsKey(projectId) });
  const update = useMutation({
    mutationFn: () => updateSegment(projectId, segment, segment.name, current),
    onSuccess: (saved) => remember(queryClient, projectId, saved),
    onError,
  });
  const same = matchesSegment(current, segment);
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate font-medium text-ink">{segment.name}</span>
          <Badge variant="outline">{VISIBILITY_LABELS[segment.visibility]}</Badge>
          {same && <Badge variant="secondary">Applied</Badge>}
          {filters === null && <Badge variant="destructive">Invalid</Badge>}
        </div>
        <p className="text-xs break-words text-ink-subtle">
          {filters === null ? INVALID_TEXT : filtersText(filters)}
        </p>
        {update.error !== null && (
          <p role="alert" className="text-xs text-destructive">
            The filters could not be saved. {segmentFailure(update.error)}
          </p>
        )}
      </div>
      {canChange && (
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={current.length === 0 || same || update.isPending}
            onClick={() => update.mutate()}
            aria-label={`Save current filters to ${segment.name}`}
          >
            {update.isPending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
            Save current filters
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={filters === null}
            onClick={() => setOpen("rename")}
            aria-label={`Rename ${segment.name}`}
          >
            Rename
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOpen("delete")}
            aria-label={`Delete ${segment.name}`}
          >
            Delete
          </Button>
        </div>
      )}
      <Dialog open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
        <DialogContent className="sm:max-w-md">
          {open === "rename" && filters !== null && (
            <RenameForm
              projectId={projectId}
              segment={segment}
              filters={filters}
              onDone={() => setOpen(null)}
            />
          )}
          {open === "delete" && (
            <DeleteForm projectId={projectId} segment={segment} onDone={() => setOpen(null)} />
          )}
        </DialogContent>
      </Dialog>
    </li>
  );
}

function RenameForm({
  projectId,
  segment,
  filters,
  onDone,
}: {
  projectId: string;
  segment: Segment;
  filters: Filters;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = React.useState(segment.name);
  const [checked, setChecked] = React.useState(false);
  const rename = useMutation({
    mutationFn: () => updateSegment(projectId, segment, name, filters),
    onSuccess: (saved) => {
      remember(queryClient, projectId, saved);
      onDone();
    },
    onError: () => void queryClient.invalidateQueries({ queryKey: segmentsKey(projectId) }),
  });
  const problem = segmentNameProblem(name);
  const taken = nameTakenError(rename.error);
  const nameError = (checked ? problem : null) ?? taken?.message ?? null;
  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setChecked(true);
        if (problem === null && !rename.isPending) rename.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>Rename the segment</DialogTitle>
      </DialogHeader>
      <NameField
        name={name}
        onName={(next) => {
          setName(next);
          if (taken !== null) rename.reset();
        }}
        error={nameError}
      />
      {rename.error !== null && taken === null && (
        <Alert variant="destructive" role="alert">
          <OctagonAlertIcon />
          <AlertDescription>{segmentFailure(rename.error)}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
        <Button type="submit" disabled={rename.isPending}>
          {rename.isPending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
          Rename
        </Button>
      </DialogFooter>
    </form>
  );
}

function DeleteForm({
  projectId,
  segment,
  onDone,
}: {
  projectId: string;
  segment: Segment;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => deleteSegment(projectId, segment),
    onSuccess: () => {
      remember(queryClient, projectId, { gone: segment.id });
      onDone();
    },
  });
  return (
    <>
      <DialogHeader>
        <DialogTitle>Delete the segment “{segment.name}”?</DialogTitle>
        <DialogDescription>
          {segment.visibility === "project"
            ? "It goes for everyone in the project. The filters on the page stay."
            : "The filters on the page stay."}
        </DialogDescription>
      </DialogHeader>
      {remove.error !== null && (
        <Alert variant="destructive" role="alert">
          <OctagonAlertIcon />
          <AlertDescription>{remove.error.message}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
        <Button variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
          {remove.isPending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
          Delete segment
        </Button>
      </DialogFooter>
    </>
  );
}
