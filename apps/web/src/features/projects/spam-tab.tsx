import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoaderCircleIcon, OctagonAlertIcon, PlusIcon } from "lucide-react";
import * as React from "react";

import { SettingsSection } from "@/components/settings-section";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ignoreOrder, useDirtyForm } from "@/hooks/use-dirty-form";
import { useAccess } from "@/lib/access";
import {
  clientAddress,
  deleteSpamVisits,
  type Project,
  previewSpamVisits,
  projectQuery,
  projectsQuery,
  type SpamCounts,
  type SpamFilters,
  updateProject,
} from "@/lib/projects-api";

import {
  checkAddresses,
  checkReferrers,
  type ListCheck,
  linesOf,
  normalAddress,
  normalDomain,
} from "./spam-rules";

/** The tab's form, as the fields hold it. */
interface SpamValues {
  ignoreDataCenters: boolean;
  /** Blocked addresses, one per line, as typed. */
  addresses: string;
  /** Blocked referrer domains, one per line, as typed. */
  referrers: string;
}

const spamValues = (project: Project): SpamValues => ({
  ignoreDataCenters: project.ignoreDataCenters,
  addresses: project.blockedAddresses.join("\n"),
  referrers: project.blockedReferrers.join("\n"),
});

/** A list compared as the API will store it, so a reordering or a repeat is no change. */
const asStored = (check: (text: string) => ListCheck) => (text: string) => {
  const checked = check(text);
  return ignoreOrder(checked.ok ? checked.entries : linesOf(text));
};

/**
 * Data centers, blocked addresses, and blocked referrers: one form, saved
 * with its Save bar under the save rule. The lists are checked as typed,
 * by the API's rules, once a field has been left or a save tried.
 */
function SpamSettings({
  project,
  onDirty,
}: {
  project: Project;
  onDirty: (dirty: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const form = useDirtyForm(spamValues(project), {
    key: project.id,
    normalize: { addresses: asStored(checkAddresses), referrers: asStored(checkReferrers) },
  });
  React.useEffect(() => onDirty(form.dirty), [onDirty, form.dirty]);
  const [touched, setTouched] = React.useState({ addresses: false, referrers: false });
  const addresses = checkAddresses(form.values.addresses);
  const referrers = checkReferrers(form.values.referrers, project.allowedHostnames);
  const addressError = touched.addresses && !addresses.ok ? addresses.message : null;
  const referrerError = touched.referrers && !referrers.ok ? referrers.message : null;

  const save = useMutation({
    mutationFn: (values: SpamValues) => {
      const blockedAddresses = checkAddresses(values.addresses);
      const blockedReferrers = checkReferrers(values.referrers, project.allowedHostnames);
      if (!blockedAddresses.ok || !blockedReferrers.ok) {
        throw new Error("Correct the lists above, then save again.");
      }
      return updateProject(project.id, {
        ignoreDataCenters: values.ignoreDataCenters,
        blockedAddresses: blockedAddresses.entries,
        blockedReferrers: blockedReferrers.entries,
      });
    },
    onSuccess: (updated, values) => {
      form.saved(values);
      queryClient.setQueryData(projectQuery(project.id).queryKey, updated);
      void queryClient.invalidateQueries({ queryKey: projectsQuery().queryKey, exact: true });
    },
  });

  const own = useMutation({ mutationFn: clientAddress });
  const [added, setAdded] = React.useState<string | null>(null);
  async function addMyAddress() {
    setAdded(null);
    const answer = await own.mutateAsync().catch(() => null);
    if (answer === null) return;
    // For IPv6, the /64: the same browser may use another of its addresses tomorrow.
    const entry = answer.network ?? answer.address;
    const listed = linesOf(form.values.addresses).map((line) => normalAddress(line) ?? line);
    if (listed.includes(entry)) {
      setAdded(`Your address ${entry} is already in the list.`);
      return;
    }
    const text = form.values.addresses.trimEnd();
    form.set("addresses", text === "" ? entry : `${text}\n${entry}`);
    setAdded(`Added your address ${entry}. Save to apply it.`);
  }

  return (
    <SettingsSection
      title="Spam and bots"
      description="Visits these rules catch are accepted and ignored: nothing is stored, and they do not count toward the project's limits. Changes apply from the next event."
      form={form}
      onSave={(values) => {
        setTouched({ addresses: true, referrers: true });
        if (addresses.ok && referrers.ok) save.mutate(values);
      }}
      saving={save.isPending}
      error={save.error?.message}
    >
      <FieldGroup>
        <Field orientation="horizontal">
          <Checkbox
            id="settings-data-centers"
            name="ignoreDataCenters"
            checked={form.values.ignoreDataCenters}
            onCheckedChange={(checked) => form.set("ignoreDataCenters", checked)}
            aria-describedby="settings-data-centers-hint"
          />
          <FieldContent>
            <FieldLabel htmlFor="settings-data-centers">Ignore visits from data centers</FieldLabel>
            <FieldDescription id="settings-data-centers-hint">
              Browsers at cloud provider addresses, such as Amazon's or Hetzner's, are nearly always
              programs, such as scrapers or tests. This also ignores people who use cloud remote
              desktops or some cloud VPNs. Disable this setting if your visitors use them.
            </FieldDescription>
          </FieldContent>
        </Field>
        <Field data-invalid={addressError !== null || undefined}>
          <FieldLabel htmlFor="settings-blocked-addresses">Blocked addresses</FieldLabel>
          <Textarea
            id="settings-blocked-addresses"
            name="blockedAddresses"
            rows={4}
            value={form.values.addresses}
            onChange={(event) => form.set("addresses", event.target.value)}
            onBlur={() => setTouched((previous) => ({ ...previous, addresses: true }))}
            placeholder={"203.0.113.7\n198.51.100.0/24\n2001:db8::/64"}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={addressError !== null || undefined}
            aria-describedby={
              addressError === null
                ? "settings-blocked-addresses-hint"
                : "settings-blocked-addresses-error"
            }
          />
          {addressError === null ? (
            <FieldDescription id="settings-blocked-addresses-hint">
              One IPv4 or IPv6 address or range per line, at most 100, such as your office's. Only
              you and other admins see this list. It is deleted with the project.
            </FieldDescription>
          ) : (
            <FieldError id="settings-blocked-addresses-error">{addressError}</FieldError>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={own.isPending}
              onClick={() => void addMyAddress()}
            >
              {own.isPending ? (
                <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
              ) : (
                <PlusIcon aria-hidden="true" />
              )}
              Add my address
            </Button>
            <output aria-live="polite" className="text-sm text-ink-muted">
              {own.isError ? `Your address could not be found: ${own.error.message}` : added}
            </output>
          </div>
        </Field>
        <Field data-invalid={referrerError !== null || undefined}>
          <FieldLabel htmlFor="settings-blocked-referrers">Blocked referrers</FieldLabel>
          <Textarea
            id="settings-blocked-referrers"
            name="blockedReferrers"
            rows={4}
            value={form.values.referrers}
            onChange={(event) => form.set("referrers", event.target.value)}
            onBlur={() => setTouched((previous) => ({ ...previous, referrers: true }))}
            placeholder={"spam.example\nfree-traffic.example"}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={referrerError !== null || undefined}
            aria-describedby={
              referrerError === null
                ? "settings-blocked-referrers-hint"
                : "settings-blocked-referrers-error"
            }
          />
          {referrerError === null ? (
            <FieldDescription id="settings-blocked-referrers-hint">
              One domain per line, at most 100. Each also blocks its subdomains. Known referrer spam
              is already ignored on every project.
            </FieldDescription>
          ) : (
            <FieldError id="settings-blocked-referrers-error">{referrerError}</FieldError>
          )}
        </Field>
      </FieldGroup>
    </SettingsSection>
  );
}

/** "YYYY-MM-DD" in a timezone. */
function dayIn(timeZone: string, moment: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(moment);
}

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The longest period one delete covers, as the API allows. */
const MAX_PERIOD_DAYS = 92;

interface FilterDraft {
  from: string;
  to: string;
  referrer: string;
  path: string;
  country: string;
}

type FilterField = keyof FilterDraft;

/** The filters as the API takes them, or what is wrong with each field. */
function checkFilters(
  draft: FilterDraft,
  today: string,
):
  | { ok: true; filters: SpamFilters }
  | { ok: false; problems: Partial<Record<FilterField, string>> } {
  const problems: Partial<Record<FilterField, string>> = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.from)) problems.from = "Choose the first day.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.to)) problems.to = "Choose the last day.";
  if (problems.from === undefined && problems.to === undefined) {
    if (draft.to > today) problems.to = "The period cannot end after today.";
    else if (draft.from > draft.to) problems.to = "The last day must not be before the first.";
    else if (addDays(draft.from, MAX_PERIOD_DAYS - 1) < draft.to) {
      problems.to = `Choose at most ${MAX_PERIOD_DAYS} days.`;
    }
  }
  const referrer = draft.referrer.trim() === "" ? undefined : normalDomain(draft.referrer);
  if (referrer === null) problems.referrer = "Enter a domain, such as spam.example.";
  const path = draft.path.trim();
  if (path !== "" && !path.startsWith("/")) {
    problems.path = "Enter a path that starts with /, such as /pricing.";
  }
  const country = draft.country.trim();
  if (country !== "" && !/^[A-Za-z]{2}$/.test(country)) {
    problems.country = "Enter a two-letter country code, such as DE.";
  }
  if (Object.keys(problems).length > 0 || referrer === null) return { ok: false, problems };
  return {
    ok: true,
    filters: {
      from: draft.from,
      to: draft.to,
      ...(referrer === undefined ? {} : { referrer }),
      ...(path === "" ? {} : { path }),
      ...(country === "" ? {} : { country: country.toUpperCase() }),
    },
  };
}

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

/** The events of the counted visits, by kind, in words. */
function eventsText(counts: SpamCounts): string {
  const parts = [
    plural(counts.pageviews, "pageview", "pageviews"),
    plural(counts.customEvents, "custom event", "custom events"),
    plural(counts.errors, "error", "errors"),
    `${plural(counts.other, "other event", "other events")} (time on page, Web Vitals)`,
  ];
  return `${plural(counts.events, "event", "events")}: ${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

/** The fields of the delete filter form, laid out two to a row from 40rem. */
function FilterInput({
  field,
  label,
  hint,
  problem,
  ...input
}: {
  field: FilterField;
  label: string;
  hint: string;
  problem: string | undefined;
} & React.ComponentProps<typeof Input>) {
  const id = `spam-filter-${field}`;
  return (
    <Field data-invalid={problem !== undefined || undefined} className="min-w-0">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        name={field}
        autoComplete="off"
        aria-invalid={problem !== undefined || undefined}
        aria-describedby={problem === undefined ? `${id}-hint` : `${id}-error`}
        {...input}
      />
      {problem === undefined ? (
        <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>
      ) : (
        <FieldError id={`${id}-error`}>{problem}</FieldError>
      )}
    </Field>
  );
}

/**
 * Deleting spam that got in: the filters, "Count visits" with what would
 * go, then a confirmation that asks for the number of visits typed. An
 * action, not part of the save rule. Delete waits for a count that matches
 * the filters as they are now.
 */
function DeleteSpam({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const timeZone = useAccess().me?.instance.timeZone ?? "UTC";
  // When the tab opened: the period's default and its latest day.
  const [openedAt] = React.useState(() => new Date());
  const today = dayIn(timeZone, openedAt);
  const [draft, setDraft] = React.useState<FilterDraft>({
    from: addDays(today, -6),
    to: today,
    referrer: "",
    path: "",
    country: "",
  });
  const [checked, setChecked] = React.useState(false);
  const check = checkFilters(draft, today);
  const problems = checked && !check.ok ? check.problems : {};
  const key = check.ok ? JSON.stringify(check.filters) : null;
  // Without a filter, every visit of the period would go: the API refuses it too.
  const hasFilter = [draft.referrer, draft.path, draft.country].some(
    (value) => value.trim() !== "",
  );

  const preview = useMutation({
    mutationFn: async (filters: SpamFilters) => ({
      key: JSON.stringify(filters),
      counts: await previewSpamVisits(project.id, filters),
    }),
  });
  const counted = preview.data !== undefined && preview.data.key === key ? preview.data : null;
  const [deleted, setDeleted] = React.useState<SpamCounts | null>(null);

  const set = (field: FilterField) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setDraft((previous) => ({ ...previous, [field]: event.target.value }));
    setDeleted(null);
  };

  const deletable =
    counted !== null &&
    counted.counts.visits > 0 &&
    counted.counts.visits <= counted.counts.limit &&
    check.ok;
  const deleteHint =
    counted === null
      ? "Count the visits first. Changing a filter asks for a new count."
      : counted.counts.visits === 0
        ? "Nothing to delete."
        : counted.counts.visits > counted.counts.limit
          ? "Too many visits for one delete."
          : null;

  return (
    <SettingsSection
      title="Delete spam"
      description="Permanently delete visits that got in before a rule above caught them. Each visit goes whole, with its time on page, Web Vitals, errors, and their replays."
      className="border-t"
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setChecked(true);
          setDeleted(null);
          if (check.ok && hasFilter && !preview.isPending) preview.mutate(check.filters);
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <FilterInput
            field="from"
            label="First day"
            hint={`In the instance's timezone, ${timeZone}.`}
            problem={problems.from}
            type="date"
            max={today}
            value={draft.from}
            onChange={set("from")}
          />
          <FilterInput
            field="to"
            label="Last day"
            hint={`At most ${MAX_PERIOD_DAYS} days in all.`}
            problem={problems.to}
            type="date"
            max={today}
            value={draft.to}
            onChange={set("to")}
          />
          <FilterInput
            field="referrer"
            label="Referrer domain (optional)"
            hint="Also matches its subdomains."
            problem={problems.referrer}
            placeholder="spam.example"
            value={draft.referrer}
            onChange={set("referrer")}
          />
          <FilterInput
            field="path"
            label="Page path (optional)"
            hint="The exact path, as reports show it."
            problem={problems.path}
            placeholder="/pricing"
            value={draft.path}
            onChange={set("path")}
          />
          <FilterInput
            field="country"
            label="Country (optional)"
            hint="A two-letter code, such as DE."
            problem={problems.country}
            placeholder="DE"
            maxLength={2}
            className="w-24"
            value={draft.country}
            onChange={set("country")}
          />
        </div>
        <p className="text-sm text-ink-muted">
          A visit goes when one of its events in the period matches every filter given.
          {draft.to === today &&
            " Visits still going on keep the events that arrive after the delete."}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            variant="outline"
            disabled={preview.isPending || !hasFilter}
            aria-describedby={hasFilter ? undefined : "spam-count-needs-filter"}
          >
            {preview.isPending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
            {preview.isPending ? "Counting…" : "Count visits"}
          </Button>
          {!hasFilter && (
            <span id="spam-count-needs-filter" className="text-sm text-ink-muted">
              Enter a referrer domain, a page path, or a country first.
            </span>
          )}
          <DeleteSpamDialog
            project={project}
            filters={check.ok ? check.filters : null}
            counts={deletable ? counted.counts : null}
            hint={deleteHint}
            onDeleted={(counts) => {
              setDeleted(counts);
              preview.reset();
              // The reports read the events that went.
              void queryClient.invalidateQueries({
                predicate: (query) =>
                  query.queryKey[1] === project.id && query.queryKey[0] !== "projects",
              });
            }}
          />
        </div>
      </form>
      <output aria-live="polite" className="flex flex-col gap-2 text-sm">
        {preview.isError && (
          <Alert variant="destructive">
            <OctagonAlertIcon />
            <AlertTitle>The visits could not be counted</AlertTitle>
            <AlertDescription>{preview.error.message}</AlertDescription>
          </Alert>
        )}
        {deleted !== null && (
          <span className="text-ink">
            Deleted {plural(deleted.visits, "visit", "visits")} and{" "}
            {plural(deleted.events, "event", "events")}. Reports no longer count them.
          </span>
        )}
        {counted !== null &&
          (counted.counts.visits === 0 ? (
            <span className="text-ink">No visits match these filters in this period.</span>
          ) : counted.counts.visits > counted.counts.limit ? (
            <span className="text-ink">
              More than {counted.counts.limit.toLocaleString("en-US")} visits match. Choose a
              shorter period or narrower filters, and delete in parts.
            </span>
          ) : (
            <span className="text-ink">
              {plural(counted.counts.visits, "visit matches", "visits match")}, with{" "}
              {eventsText(counted.counts)}.
              {counted.counts.replays > 0 &&
                ` ${plural(counted.counts.replays, "session replay goes", "session replays go")} with them.`}
            </span>
          ))}
        {counted === null && preview.data !== undefined && (
          <span className="text-ink-muted">The filters changed. Count the visits again.</span>
        )}
      </output>
    </SettingsSection>
  );
}

/** Deletes the counted visits once their number is typed, as the API also requires. */
function DeleteSpamDialog({
  project,
  filters,
  counts,
  hint,
  onDeleted,
}: {
  project: Project;
  filters: SpamFilters | null;
  /** The current count, or null while there is nothing to delete. */
  counts: SpamCounts | null;
  /** Why Delete is disabled, when it is. */
  hint: string | null;
  onDeleted: (counts: SpamCounts) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [typed, setTyped] = React.useState("");
  const remove = useMutation({
    mutationFn: () => {
      if (filters === null || counts === null) throw new Error("Count the visits first.");
      return deleteSpamVisits(project.id, filters, counts.visits);
    },
    onSuccess: (result) => {
      setOpen(false);
      setTyped("");
      onDeleted(result);
    },
  });
  const hintId = React.useId();
  const matches = counts !== null && typed.trim() === String(counts.visits);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setTyped("");
          remove.reset();
        }
      }}
    >
      <Button
        type="button"
        variant="destructive"
        disabled={counts === null}
        aria-describedby={hint === null ? undefined : hintId}
        onClick={() => setOpen(true)}
      >
        Delete visits
      </Button>
      {hint !== null && (
        <span id={hintId} className="text-sm text-ink-muted">
          {hint}
        </span>
      )}
      {counts !== null && (
        <DialogContent className="sm:max-w-md">
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              // React passes events up through the portal: not to the filters' form.
              event.stopPropagation();
              if (matches && !remove.isPending) remove.mutate();
            }}
          >
            <DialogHeader>
              <DialogTitle>Delete {plural(counts.visits, "visit", "visits")}?</DialogTitle>
              <DialogDescription>
                This permanently deletes {plural(counts.visits, "visit", "visits")} with{" "}
                {eventsText(counts)}
                {counts.replays > 0
                  ? `, and ${plural(counts.replays, "session replay", "session replays")}`
                  : ""}
                . It cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <Field>
              <FieldLabel htmlFor="spam-delete-confirm">Type {counts.visits} to confirm</FieldLabel>
              <Input
                id="spam-delete-confirm"
                inputMode="numeric"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                autoComplete="off"
              />
            </Field>
            {remove.error !== null && (
              <Alert variant="destructive" role="alert">
                <OctagonAlertIcon />
                <AlertDescription>{remove.error.message}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
              <Button type="submit" variant="destructive" disabled={!matches || remove.isPending}>
                {remove.isPending && (
                  <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
                )}
                Delete permanently
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}

/** The Spam and bots tab: the rules that keep spam out, and deleting what got in. */
export function SpamTab({
  project,
  onDirty,
}: {
  project: Project;
  onDirty: (dirty: boolean) => void;
}) {
  return (
    <>
      <SpamSettings project={project} onDirty={onDirty} />
      <DeleteSpam project={project} />
    </>
  );
}
