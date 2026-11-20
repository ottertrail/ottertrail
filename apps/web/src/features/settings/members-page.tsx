import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { EllipsisIcon, MailIcon, OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { clickableRow, ROW_LINK } from "@/components/clickable-row";
import { NoAccess } from "@/components/no-access";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UnsavedChangesGuard } from "@/components/unsaved-changes-guard";
import { GUTTER_END, GUTTER_START, LIST_HEAD } from "@/components/workbench-rows";
import { PHONE, useMediaQuery } from "@/hooks/use-media-query";
import { useSearchParam } from "@/hooks/use-search-param";
import { meQuery, type Role } from "@/lib/access";
import {
  handOverOwnership,
  type Invitation,
  makeResetLink,
  type Member,
  membersQuery,
  removeMember,
  renewInvitation,
  revokeInvitation,
} from "@/lib/members-api";
import { projectsQuery } from "@/lib/projects-api";

import { formatDay, formatMoment } from "../users/format";
import { accessSummary } from "./access-text";
import {
  AccessSheet,
  ActionDialog,
  type Actor,
  type FinalFocus,
  InviteDialog,
  LINK_ONCE,
} from "./member-dialogs";
import { TruncatedText } from "./truncated-text";

/** Whether `actor` may change, remove, or reset `target`: the API's rule (access/members.ts). */
function mayManage(actor: Actor, target: { id: string; role: Role }) {
  if (target.id === actor.id || target.role === "owner") return false;
  if (actor.role === "owner") return true;
  return actor.role === "admin" && target.role === "member";
}

/** Whether `actor` may hand ownership to `target`: the owner, to anyone else. */
const mayHandOver = (actor: Actor, target: Member) =>
  actor.role === "owner" && target.id !== actor.id;

/** Whether `actor` may renew or revoke an invitation: an admin's only the owner (access/invitations.ts). */
const mayActOnInvitation = (actor: Actor, invitation: Invitation) =>
  actor.role === "owner" || invitation.role === "member";

const ROLE_NAME: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/** What someone may reach: "Everything" for the owner and admins, a member's summary. */
const accessText = (access: Member["access"]) =>
  access === null ? "Everything" : accessSummary(access);

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** "in 5 days", "in 3 hours": how long an invitation's link still works; null once expired. */
function expiresIn(iso: string, now: number): string | null {
  const left = Date.parse(iso) - now;
  if (left <= 0) return null;
  const format = new Intl.RelativeTimeFormat("en", { numeric: "always" });
  if (left >= DAY) return format.format(Math.round(left / DAY), "day");
  if (left >= HOUR) return format.format(Math.floor(left / HOUR), "hour");
  return format.format(Math.max(1, Math.floor(left / 60_000)), "minute");
}

const isExpired = (invitation: Invitation, now: number) => Date.parse(invitation.expiresAt) <= now;

/** The row's menu button, by the person or invitation it acts on. */
const menuButton = (id: string) =>
  document.querySelector<HTMLElement>(`[data-actions-for="${CSS.escape(id)}"]`);
const tabButton = (tab: Tab) => document.querySelector<HTMLElement>(`[data-members-tab="${tab}"]`);

type Tab = "members" | "invitations";

/** What is open: the sheet or a dialog, and whom it acts on. */
type Action =
  | { kind: "access" | "reset" | "owner" | "remove"; id: string }
  | { kind: "renew" | "revoke"; id: string };

/** A row's actions menu, named for the person or invitation. */
function RowMenu({ id, name, children }: { id: string; name: string; children: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            data-actions-for={id}
            aria-label={`More actions for ${name}`}
            className="relative after:absolute after:-inset-1.5"
          />
        }
      >
        <EllipsisIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-44">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A member's name: the button the row's click stands for where it opens Change access. */
function PersonName({
  member,
  onOpen,
}: {
  member: Member;
  /** Opens Change access; left out where the viewer may not change them. */
  onOpen: (() => void) | undefined;
}) {
  if (onOpen === undefined) {
    return <TruncatedText text={member.name} className="font-medium text-ink" />;
  }
  return (
    <TruncatedText
      text={member.name}
      className="text-left font-medium text-link hover:underline"
      render={
        <button
          type="button"
          {...ROW_LINK}
          aria-label={`${member.name}, change access`}
          onClick={onOpen}
        />
      }
    />
  );
}

const youBadge = (
  <Badge variant="secondary" className="shrink-0">
    You
  </Badge>
);

function MembersTable({
  members,
  actor,
  phone,
  timeZone,
  onAction,
}: {
  members: readonly Member[];
  actor: Actor;
  phone: boolean;
  timeZone: string | undefined;
  onAction: (action: Action) => void;
}) {
  const lastSignIn = (member: Member) =>
    member.lastSignInAt === null ? "Never" : formatDay(member.lastSignInAt, timeZone);
  const menu = (member: Member) => {
    const manage = mayManage(actor, member);
    if (!manage && !mayHandOver(actor, member)) return null;
    const act = (kind: "access" | "reset" | "owner" | "remove") => () =>
      onAction({ kind, id: member.id });
    return (
      <RowMenu id={member.id} name={member.name}>
        {manage && <DropdownMenuItem onClick={act("access")}>Change access</DropdownMenuItem>}
        {manage && <DropdownMenuItem onClick={act("reset")}>Make reset link</DropdownMenuItem>}
        {mayHandOver(actor, member) && (
          <DropdownMenuItem onClick={act("owner")}>Make owner</DropdownMenuItem>
        )}
        {manage && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={act("remove")}>
              Remove
            </DropdownMenuItem>
          </>
        )}
      </RowMenu>
    );
  };
  const opener = (member: Member) =>
    mayManage(actor, member) ? () => onAction({ kind: "access", id: member.id }) : undefined;

  return (
    <Table className={cn(phone && "table-fixed")}>
      <caption className="sr-only">Members</caption>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col" className={cn(LIST_HEAD, GUTTER_START)}>
            {phone ? "Member" : "Name"}
          </TableHead>
          {!phone && (
            <>
              <TableHead scope="col" className={LIST_HEAD}>
                Role
              </TableHead>
              <TableHead scope="col" className={LIST_HEAD}>
                Access
              </TableHead>
              <TableHead scope="col" className={LIST_HEAD}>
                Last sign-in
              </TableHead>
            </>
          )}
          <TableHead scope="col" className={cn(LIST_HEAD, GUTTER_END, "w-14")}>
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {members.map((member) => {
          const manage = mayManage(actor, member);
          const you = member.id === actor.id;
          const access = accessText(member.access);
          return (
            <TableRow key={member.id} {...clickableRow(undefined, manage)}>
              {phone ? (
                <TableCell className={cn(GUTTER_START, "py-2.5 whitespace-normal")}>
                  <div className="flex min-w-0 items-center gap-2">
                    <PersonName member={member} onOpen={opener(member)} />
                    {you && youBadge}
                    <span className="ml-auto shrink-0 text-ink-muted">
                      {ROLE_NAME[member.role]}
                    </span>
                  </div>
                  <TruncatedText text={member.email} className="text-xs text-ink-subtle" />
                  <div className="flex min-w-0 gap-1 text-xs text-ink-muted">
                    <TruncatedText text={access} />
                    <span className="shrink-0" aria-hidden="true">
                      ·
                    </span>
                    <span className="shrink-0">
                      <span className="sr-only">Last sign-in </span>
                      {lastSignIn(member)}
                    </span>
                  </div>
                </TableCell>
              ) : (
                <>
                  <TableCell className={cn(GUTTER_START, "py-2.5")}>
                    <div className="flex max-w-80 min-w-0 items-center gap-2">
                      <PersonName member={member} onOpen={opener(member)} />
                      {you && youBadge}
                    </div>
                    <TruncatedText
                      text={member.email}
                      className="max-w-80 text-xs text-ink-subtle"
                    />
                  </TableCell>
                  <TableCell className="text-ink-muted">{ROLE_NAME[member.role]}</TableCell>
                  <TableCell className="text-ink-muted">
                    <TruncatedText text={access} className="max-w-96" />
                  </TableCell>
                  <TableCell className="text-ink-muted tabular-nums">
                    {member.lastSignInAt === null ? (
                      "Never"
                    ) : (
                      <time dateTime={member.lastSignInAt}>{lastSignIn(member)}</time>
                    )}
                  </TableCell>
                </>
              )}
              <TableCell className={cn(GUTTER_END, "text-right")}>{menu(member)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** When an invitation's link stops working: "in 5 days", the moment in its tooltip-free text. */
function Expiry({
  invitation,
  now,
  timeZone,
}: {
  invitation: Invitation;
  now: number;
  timeZone: string | undefined;
}) {
  const left = expiresIn(invitation.expiresAt, now);
  if (left === null) return <StatusBadge tone="warning">Expired</StatusBadge>;
  return (
    <time dateTime={invitation.expiresAt} title={formatMoment(invitation.expiresAt, timeZone)}>
      {left}
    </time>
  );
}

function InvitationsTable({
  invitations,
  actor,
  phone,
  now,
  timeZone,
  onAction,
}: {
  invitations: readonly Invitation[];
  actor: Actor;
  phone: boolean;
  now: number;
  timeZone: string | undefined;
  onAction: (action: Action) => void;
}) {
  const menu = (invitation: Invitation) =>
    mayActOnInvitation(actor, invitation) ? (
      <RowMenu id={invitation.id} name={invitation.email}>
        <DropdownMenuItem onClick={() => onAction({ kind: "renew", id: invitation.id })}>
          New link
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => onAction({ kind: "revoke", id: invitation.id })}
        >
          Revoke
        </DropdownMenuItem>
      </RowMenu>
    ) : null;
  return (
    <Table className={cn(phone && "table-fixed")}>
      <caption className="sr-only">Pending invitations</caption>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col" className={cn(LIST_HEAD, GUTTER_START)}>
            {phone ? "Invitation" : "Email"}
          </TableHead>
          {!phone && (
            <>
              <TableHead scope="col" className={LIST_HEAD}>
                Role
              </TableHead>
              <TableHead scope="col" className={LIST_HEAD}>
                Access
              </TableHead>
              <TableHead scope="col" className={LIST_HEAD}>
                Invited by
              </TableHead>
              <TableHead scope="col" className={LIST_HEAD}>
                Created
              </TableHead>
              <TableHead scope="col" className={LIST_HEAD}>
                Expires
              </TableHead>
            </>
          )}
          <TableHead scope="col" className={cn(LIST_HEAD, GUTTER_END, "w-14")}>
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {invitations.map((invitation) => {
          const access = accessText(invitation.access);
          return (
            <TableRow key={invitation.id}>
              {phone ? (
                <TableCell className={cn(GUTTER_START, "py-2.5 whitespace-normal")}>
                  <div className="flex min-w-0 items-center gap-2">
                    <TruncatedText text={invitation.email} className="font-medium text-ink" />
                    <span className="ml-auto shrink-0 text-ink-muted">
                      {ROLE_NAME[invitation.role]}
                    </span>
                  </div>
                  <TruncatedText text={access} className="text-xs text-ink-muted" />
                  <p className="flex min-w-0 flex-wrap gap-x-1 text-xs text-ink-subtle">
                    <span>
                      Expires <Expiry invitation={invitation} now={now} timeZone={timeZone} />
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      Invited by {invitation.invitedBy.name}
                    </span>
                  </p>
                </TableCell>
              ) : (
                <>
                  <TableCell className={cn(GUTTER_START, "py-2.5")}>
                    <TruncatedText
                      text={invitation.email}
                      className="max-w-72 font-medium text-ink"
                    />
                  </TableCell>
                  <TableCell className="text-ink-muted">{ROLE_NAME[invitation.role]}</TableCell>
                  <TableCell className="text-ink-muted">
                    <TruncatedText text={access} className="max-w-80" />
                  </TableCell>
                  <TableCell className="text-ink-muted">
                    <TruncatedText text={invitation.invitedBy.name} className="max-w-48" />
                  </TableCell>
                  <TableCell className="text-ink-muted tabular-nums">
                    <time dateTime={invitation.createdAt}>
                      {formatDay(invitation.createdAt, timeZone)}
                    </time>
                  </TableCell>
                  <TableCell className="text-ink-muted tabular-nums">
                    <Expiry invitation={invitation} now={now} timeZone={timeZone} />
                  </TableCell>
                </>
              )}
              <TableCell className={cn(GUTTER_END, "text-right")}>{menu(invitation)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** Under the members table: what the viewer can't do here, why, and what to do instead. */
function membersNote(actor: Actor) {
  return actor.role === "owner"
    ? "You're the owner, so you keep access to everything, and you can't change your own access or remove yourself. To give the instance to someone else, open their row's menu and choose Make owner."
    : "As an admin, you can change, reset, and remove members. Admins and the owner have no menu here, because only the owner can change an admin, and nobody can change the owner or their own access. Ask the owner if this needs doing.";
}

/** The page's shape while it loads: the tab row, then rows. */
function MembersSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading members">
      <div className="flex h-12 items-center justify-between gap-3 border-b px-gutter">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-8 w-20" />
      </div>
      <div className="flex flex-col gap-3 px-gutter py-4">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}

/** "3" after a tab's label, read as part of it. */
const tabCount = (n: number) => (
  <span className="text-ink-subtle tabular-nums group-data-active/tab:text-ink-muted">{n}</span>
);

/**
 * The Members page (/settings/members; docs/access.md): two tabs, Members
 * and Invitations (`?tab=invitations`), each a table. A row's menu holds what
 * the viewer may do to that person within the role rules, and a click on a
 * member's row opens Change access, a sheet, where the viewer may change it.
 * Invite, at the top right, makes an invitation link.
 */
export function MembersPage() {
  const me = useQuery(meQuery());
  const allowed = me.data?.permissions.members === true;
  const members = useQuery({ ...membersQuery(), enabled: allowed });
  const projects = useQuery({ ...projectsQuery(), enabled: allowed });
  const phone = useMediaQuery(PHONE);
  const [tabParam, setTab] = useSearchParam("tab");
  const tab: Tab = tabParam === "invitations" ? "invitations" : "members";
  // When the page opened: invitations past it show as expired.
  const [now] = React.useState(() => Date.now());
  // What the last removal, revocation or save did: said once, until the next action.
  const [notice, setNotice] = React.useState("");
  // What is open, and whether: kept while it closes, so its content stays for the animation.
  const [action, setAction] = React.useState<Action | null>(null);
  const [open, setOpen] = React.useState(false);
  // Opened again for the same person, the sheet or dialog starts afresh.
  const [opened, setOpened] = React.useState(0);
  const [password, setPassword] = React.useState("");
  // Where focus goes once the sheet or dialog closes: a row's menu button, or a tab.
  const focusTo = React.useRef<{ menu: string } | { tab: Tab } | null>(null);
  const finalFocus = React.useCallback<FinalFocus>(() => {
    const to = focusTo.current;
    if (to === null) return true;
    const element = "menu" in to ? menuButton(to.menu) : tabButton(to.tab);
    return element ?? tabButton("members") ?? true;
  }, []);

  if (me.data !== undefined && !allowed) {
    return <NoAccess />;
  }
  const timeZone = me.data?.instance.timeZone;
  const failed = members.error ?? projects.error;
  if (failed !== null) {
    return (
      <div className="max-w-3xl px-gutter py-6">
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>Members could not load</AlertTitle>
          <AlertDescription>{failed.message}</AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void members.refetch();
                void projects.refetch();
              }}
            >
              Retry
            </Button>
          </AlertAction>
        </Alert>
      </div>
    );
  }
  const data = members.data;
  if (data === undefined || projects.data === undefined) {
    return <MembersSkeleton />;
  }
  const actor = data.you;
  const pending = data.invitations.filter((item) => !isExpired(item, now)).length;

  const start = (next: Action) => {
    focusTo.current = { menu: next.id };
    setNotice("");
    setPassword("");
    setAction(next);
    setOpened((n) => n + 1);
    setOpen(true);
  };

  // The row is going: focus goes to the nearest row after it with a menu (before it, at the
  // end), or with none left, to its tab.
  const leaveRow = (id: string, text: string) => {
    const kind: Tab = data.members.some((item) => item.id === id) ? "members" : "invitations";
    const withMenus =
      kind === "members"
        ? data.members
            .filter((item) => item.id === id || mayManage(actor, item) || mayHandOver(actor, item))
            .map((item) => item.id)
        : data.invitations
            .filter((item) => item.id === id || mayActOnInvitation(actor, item))
            .map((item) => item.id);
    const at = withMenus.indexOf(id);
    const next = withMenus[at + 1] ?? withMenus[at - 1];
    focusTo.current = next === undefined ? { tab: kind } : { menu: next };
    setNotice(text);
  };

  const member =
    action !== null && action.kind !== "renew" && action.kind !== "revoke"
      ? data.members.find((item) => item.id === action.id)
      : undefined;
  const invitation =
    action?.kind === "renew" || action?.kind === "revoke"
      ? data.invitations.find((item) => item.id === action.id)
      : undefined;
  const dialogKey = `${action?.kind}-${action?.id}-${opened}`;

  const dialog = (() => {
    if (action === null) return null;
    if (member !== undefined) {
      switch (action.kind) {
        case "access":
          return (
            <AccessSheet
              key={dialogKey}
              member={member}
              actor={actor}
              projects={projects.data}
              open={open}
              onOpenChange={setOpen}
              finalFocus={finalFocus}
              onSaved={() => setNotice(`${member.name}'s access was saved.`)}
            />
          );
        case "reset":
          return (
            <ActionDialog
              key={dialogKey}
              open={open}
              onOpenChange={setOpen}
              finalFocus={finalFocus}
              title={`A reset link for ${member.name}`}
              description={`A reset link lets ${member.name} set a new password. Ottertrail doesn't email it, since many self-hosted servers have no mail server set up, so you send it to them yourself. It works once, within 24 hours. Using it signs them out everywhere. Their old password works until then, and a new link replaces any earlier one.`}
              confirmLabel="Make the link"
              linkAbout={`Send this link to ${member.name} yourself, for example in a chat or an email. ${LINK_ONCE} If it gets lost, make a new one from their row's menu.`}
              run={() => makeResetLink(member.id)}
            />
          );
        case "owner":
          return (
            <ActionDialog
              key={dialogKey}
              open={open}
              onOpenChange={setOpen}
              finalFocus={finalFocus}
              title={`Make ${member.name} the owner?`}
              description="They get the instance settings and everything else, and you become an admin. Only the new owner can make you the owner again. Enter your password to confirm it's you."
              confirmLabel="Hand over ownership"
              destructive
              canConfirm={password !== ""}
              onClear={() => setPassword("")}
              run={async () => {
                await handOverOwnership(member.id, password);
                return undefined;
              }}
              onDone={() => setNotice(`${member.name} is now the owner. You're an admin.`)}
            >
              <Field>
                <FieldLabel htmlFor={`password-${member.id}`}>Your password</FieldLabel>
                <Input
                  id={`password-${member.id}`}
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
            </ActionDialog>
          );
        case "remove":
          return (
            <ActionDialog
              key={dialogKey}
              open={open}
              onOpenChange={setOpen}
              finalFocus={finalFocus}
              title={`Remove ${member.name}?`}
              description="This deletes their account and signs them out at once. What they did, such as resolving errors, stays recorded. Invitations they sent are revoked too, so those people need a new invitation."
              confirmLabel="Remove"
              destructive
              run={async () => {
                await removeMember(member.id);
                return undefined;
              }}
              onDone={() => leaveRow(member.id, `${member.name} was removed.`)}
            />
          );
        default:
          return null;
      }
    }
    if (invitation !== undefined) {
      return action.kind === "renew" ? (
        <ActionDialog
          key={dialogKey}
          open={open}
          onOpenChange={setOpen}
          finalFocus={finalFocus}
          title={`A new link for ${invitation.email}`}
          description={`Use this to replace a lost link: Ottertrail keeps only a fingerprint of each link, so it can't show it again. The old link stops working at once, and the new one works once, for ${data.invitationDays} days.`}
          confirmLabel="Make a new link"
          linkAbout={`Send this link to ${invitation.email} yourself, for example in a chat or an email. ${LINK_ONCE}`}
          run={() => renewInvitation(invitation.id)}
        />
      ) : (
        <ActionDialog
          key={dialogKey}
          open={open}
          onOpenChange={setOpen}
          finalFocus={finalFocus}
          title={`Revoke the invitation of ${invitation.email}?`}
          description={`Its link stops working at once, so ${invitation.email} can't join with it. To invite them again later, use Invite.`}
          confirmLabel="Revoke"
          destructive
          run={async () => {
            await revokeInvitation(invitation.id);
            return undefined;
          }}
          onDone={() =>
            leaveRow(invitation.id, `The invitation of ${invitation.email} was revoked.`)
          }
        />
      );
    }
    return null;
  })();

  const adminInvitationsLocked =
    actor.role !== "owner" && data.invitations.some((item) => !mayActOnInvitation(actor, item));

  return (
    <UnsavedChangesGuard>
      <output
        aria-live="polite"
        data-slot="members-notice"
        className="block border-b px-gutter py-3 text-sm text-ink empty:border-0 empty:p-0"
      >
        {notice}
      </output>
      <Tabs
        value={tab}
        onValueChange={(next) => {
          if (next === "members" || next === "invitations") {
            setNotice("");
            setTab(next === "members" ? undefined : next);
          }
        }}
        className="gap-0"
      >
        <div className="flex items-center gap-3 border-b px-gutter">
          <div className="min-w-0 flex-1 overflow-x-auto">
            <TabsList variant="line" aria-label="Members and invitations" className="h-12">
              <TabsTrigger
                value="members"
                data-members-tab="members"
                className="group/tab h-12 flex-none px-3 after:bg-primary"
              >
                Members
                {tabCount(data.members.length)}
              </TabsTrigger>
              <TabsTrigger
                value="invitations"
                data-members-tab="invitations"
                className="h-12 flex-none px-3 after:bg-primary"
              >
                Invitations
                {pending > 0 && (
                  <>
                    <Badge variant="secondary" aria-hidden="true" className="tabular-nums">
                      {pending}
                    </Badge>
                    <span className="sr-only">{pending} pending</span>
                  </>
                )}
              </TabsTrigger>
            </TabsList>
          </div>
          <InviteDialog actor={actor} projects={projects.data} days={data.invitationDays} />
        </div>
        <TabsContent value="members">
          <MembersTable
            members={data.members}
            actor={actor}
            phone={phone}
            timeZone={timeZone}
            onAction={start}
          />
          <p className="max-w-3xl px-gutter py-4 text-sm text-pretty text-ink-subtle">
            {membersNote(actor)}
          </p>
        </TabsContent>
        <TabsContent value="invitations">
          {data.invitations.length === 0 ? (
            <div className="px-gutter py-6">
              <Empty className="border border-dashed p-10">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <MailIcon />
                  </EmptyMedia>
                  <EmptyTitle>No pending invitations</EmptyTitle>
                  <EmptyDescription>
                    Nobody is waiting to join. To add someone, choose Invite at the top of the page,
                    then copy the link it makes and send it to them yourself.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          ) : (
            <>
              <InvitationsTable
                invitations={data.invitations}
                actor={actor}
                phone={phone}
                now={now}
                timeZone={timeZone}
                onAction={start}
              />
              <div className="flex max-w-3xl flex-col gap-2 px-gutter py-4 text-sm text-pretty text-ink-subtle">
                <p>
                  Ottertrail can't show an invitation's link again after it's made, because it keeps
                  only a fingerprint of the link. If someone lost theirs, choose New link in their
                  row's menu. To invite someone else, use Invite.
                </p>
                {adminInvitationsLocked && (
                  <p>
                    Invitations to be an admin have no menu for you, because only the owner can
                    renew or revoke them. Ask the owner if one needs a new link.
                  </p>
                )}
              </div>
            </>
          )}
        </TabsContent>
      </Tabs>
      {dialog}
    </UnsavedChangesGuard>
  );
}
