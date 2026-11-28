import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LinkIcon, LoaderCircleIcon, OctagonAlertIcon, PlusIcon } from "lucide-react";
import * as React from "react";

import { CopyableCode } from "@/components/copyable-code";
import { SettingsSection } from "@/components/settings-section";
import { TruncatedText } from "@/components/truncated-text";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { DEFAULT_ENVIRONMENT } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import {
  createShareLink,
  type NewShareLink,
  revokeShareLink,
  type ShareLink,
  type ShareLinks,
  shareLinksQuery,
} from "@/lib/share-links-api";

import { timeAgo } from "./format";

/*
 * The project's shared links (docs/web-analytics.md, "Shared links"): a
 * secret address that shows the project's Web analytics, read-only, to
 * anyone who has it. Making and revoking act at once, as a list's quick
 * actions do (the save rule): there is no form to save.
 */

const ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

function NewLinkDialog({
  projectId,
  atLimit,
  limit,
}: {
  projectId: string;
  atLimit: boolean;
  limit: number;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [environment, setEnvironment] = React.useState(DEFAULT_ENVIRONMENT);
  const reasonId = React.useId();
  const make = useMutation({
    mutationFn: () =>
      createShareLink(projectId, { name: name.trim(), environment: environment.trim() }),
    onSuccess: ({ link }: NewShareLink) => {
      queryClient.setQueryData<ShareLinks>(shareLinksQuery(projectId).queryKey, (list) =>
        list === undefined ? list : { ...list, links: [...list.links, link] },
      );
      void queryClient.invalidateQueries({ queryKey: shareLinksQuery(projectId).queryKey });
    },
  });
  const environmentOk = ENVIRONMENT.test(environment.trim());
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          make.reset();
          setName("");
          setEnvironment(DEFAULT_ENVIRONMENT);
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          variant="outline"
          disabled={atLimit}
          aria-describedby={atLimit ? reasonId : undefined}
          onClick={() => setOpen(true)}
        >
          <PlusIcon aria-hidden="true" />
          New link
        </Button>
        {atLimit && (
          <span id={reasonId} className="text-xs text-ink-subtle">
            A project has at most {limit} shared links. Revoke one to make another.
          </span>
        )}
      </div>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{make.data === undefined ? "New shared link" : "Copy the link"}</DialogTitle>
          {make.data === undefined && (
            <DialogDescription className="text-pretty">
              Anyone with the link sees this project&apos;s Web analytics, without signing in.
            </DialogDescription>
          )}
        </DialogHeader>
        {make.data === undefined ? (
          <form
            className="flex flex-col gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              make.mutate();
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="share-link-name">Name</FieldLabel>
                <Input
                  id="share-link-name"
                  required
                  maxLength={100}
                  autoComplete="off"
                  placeholder="For the client"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="share-link-environment">Environment</FieldLabel>
                <Input
                  id="share-link-environment"
                  required
                  maxLength={64}
                  autoComplete="off"
                  spellCheck={false}
                  value={environment}
                  aria-invalid={!environmentOk}
                  onChange={(event) => setEnvironment(event.target.value)}
                />
                <FieldDescription>The link shows this environment only.</FieldDescription>
              </Field>
            </FieldGroup>
            {make.error !== null && (
              <Alert variant="destructive" role="alert">
                <OctagonAlertIcon />
                <AlertDescription>{make.error.message}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
              <Button
                type="submit"
                disabled={make.isPending || name.trim() === "" || !environmentOk}
              >
                {make.isPending && (
                  <LoaderCircleIcon
                    aria-hidden="true"
                    className="animate-spin motion-reduce:animate-none"
                  />
                )}
                Make link
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <>
            <div className="flex flex-col gap-3">
              <p className="text-sm text-pretty text-ink-muted">
                Only a fingerprint is saved, so this link can&apos;t be shown again. Copy it now.
              </p>
              <CopyableCode text={make.data.url} copyLabel="Copy the link" />
            </div>
            <DialogFooter>
              <DialogClose render={<Button type="button" />}>Done</DialogClose>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RevokeDialog({
  projectId,
  link,
  returnFocus,
}: {
  projectId: string;
  link: ShareLink;
  returnFocus: React.RefObject<HTMLElement | null>;
}) {
  const [open, setOpen] = React.useState(false);
  const revoked = React.useRef(false);
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: async () => {
      try {
        await revokeShareLink(projectId, link.id);
      } catch (error) {
        // Revoked in another tab already: the same outcome.
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }
    },
    onSuccess: () => {
      revoked.current = true;
      setOpen(false);
      queryClient.setQueryData<ShareLinks>(shareLinksQuery(projectId).queryKey, (list) =>
        list === undefined
          ? list
          : { ...list, links: list.links.filter((item) => item.id !== link.id) },
      );
      void queryClient.invalidateQueries({ queryKey: shareLinksQuery(projectId).queryKey });
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) revoke.reset();
      }}
    >
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Revoke<span className="sr-only"> {link.name}</span>
      </Button>
      <DialogContent
        className="sm:max-w-md"
        finalFocus={() => (revoked.current && returnFocus.current) || true}
      >
        <DialogHeader>
          <DialogTitle>Revoke {link.name}?</DialogTitle>
          <DialogDescription className="text-pretty">
            The link stops working at once, for everyone who has it. To share again, make a new
            link.
          </DialogDescription>
        </DialogHeader>
        {revoke.error !== null && (
          <Alert variant="destructive" role="alert">
            <OctagonAlertIcon />
            <AlertDescription>{revoke.error.message}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
          <Button variant="destructive" onClick={() => revoke.mutate()} disabled={revoke.isPending}>
            {revoke.isPending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
            Revoke link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function When({ at }: { at: string }) {
  return (
    <time dateTime={at} title={new Date(at).toLocaleString()}>
      {timeAgo(new Date(at))}
    </time>
  );
}

/** On a phone, each row stacks, with its column's name before each value. */
const stackCell =
  "max-sm:flex max-sm:justify-between max-sm:gap-3 max-sm:py-0.5 max-sm:before:text-ink-subtle max-sm:before:content-[attr(data-label)]";

function LinkTable({
  projectId,
  links,
  returnFocus,
}: {
  projectId: string;
  links: ShareLink[];
  returnFocus: React.RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <table className="w-full text-sm max-sm:block sm:table-fixed">
      <caption className="sr-only">Shared links, oldest first</caption>
      <thead className="max-sm:sr-only">
        <tr className="text-xs text-ink-subtle">
          <th scope="col" className="pb-2 text-left font-normal">
            Name
          </th>
          <th scope="col" className="w-28 pb-2 text-left font-normal">
            Environment
          </th>
          <th scope="col" className="w-24 pb-2 text-left font-normal">
            Link
          </th>
          <th scope="col" className="w-56 pb-2 text-left font-normal">
            Made
          </th>
          <th scope="col" className="w-28 pb-2 text-left font-normal">
            Last opened
          </th>
          <th scope="col" className="w-20 pb-2">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody className="max-sm:block">
        {links.map((link) => (
          <tr
            key={link.id}
            className="border-t border-hairline max-sm:flex max-sm:flex-col max-sm:py-2"
          >
            <th scope="row" className="py-1.5 pr-3 text-left font-normal text-ink">
              <TruncatedText text={link.name} />
            </th>
            <td data-label="Environment" className={`py-1.5 pr-3 text-ink-muted ${stackCell}`}>
              <TruncatedText text={link.environment} />
            </td>
            <td data-label="Link" className={`py-1.5 pr-3 font-mono text-ink-muted ${stackCell}`}>
              <span title="The link's first characters">{link.prefix}…</span>
            </td>
            <td data-label="Made" className={`py-1.5 pr-3 text-ink-muted ${stackCell}`}>
              <TruncatedText
                text={`${timeAgo(new Date(link.createdAt))}${link.createdBy === null ? "" : ` by ${link.createdBy.name}`}`}
              />
            </td>
            <td data-label="Last opened" className={`py-1.5 pr-3 text-ink-muted ${stackCell}`}>
              {link.lastOpenedAt === null ? "Never" : <When at={link.lastOpenedAt} />}
            </td>
            <td className="py-0.5 text-right max-sm:-ms-2.5 max-sm:text-left">
              <RevokeDialog projectId={projectId} link={link} returnFocus={returnFocus} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The Shared links tab of a project's settings (the owner and admins only). */
export function ShareLinksTab({ projectId }: { projectId: string }) {
  const query = useQuery(shareLinksQuery(projectId));
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  return (
    <SettingsSection
      title="Shared links"
      headingRef={headingRef}
      wide
      description="A shared link shows this project's Web analytics, read-only, to anyone who has it. Nothing else: no users, errors, replays, or settings."
    >
      {query.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : query.isError ? (
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>The shared links could not load</AlertTitle>
          <AlertDescription>{query.error.message}</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : (
        // One dialog for both states: the new link it shows stays when the list stops being empty.
        <div className="flex flex-col gap-4">
          <NewLinkDialog
            projectId={projectId}
            atLimit={query.data.links.length >= query.data.maxLinks}
            limit={query.data.maxLinks}
          />
          {query.data.links.length === 0 ? (
            <Empty className="border border-dashed p-6">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <LinkIcon />
                </EmptyMedia>
                <EmptyTitle>No shared links</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <LinkTable projectId={projectId} links={query.data.links} returnFocus={headingRef} />
          )}
        </div>
      )}
    </SettingsSection>
  );
}
