import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import {
  ArrowLeftIcon,
  InfoIcon,
  LoaderCircleIcon,
  OctagonAlertIcon,
  UserPlusIcon,
} from "lucide-react";
import * as React from "react";

import { CopyableCode } from "@/components/copyable-code";
import { NoAccess } from "@/components/no-access";
import { SettingsSection } from "@/components/settings-section";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
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
import { UnsavedChangesGuard } from "@/components/unsaved-changes-guard";
import { GUTTER_END, GUTTER_START, LIST_HEAD, SELECTED_ROW } from "@/components/workbench-rows";
import { ignoreOrder, useDirtyForm } from "@/hooks/use-dirty-form";
import { NARROW_WORKBENCH, PHONE, useMediaQuery } from "@/hooks/use-media-query";
import { meQuery, type Role } from "@/lib/access";
import {
  type AccessChoice,
  changeMember,
  handOverOwnership,
  type Invitation,
  inviteMember,
  makeResetLink,
  type Member,
  membersKey,
  membersQuery,
  removeMember,
  renewInvitation,
  revokeInvitation,
} from "@/lib/members-api";
import { projectsQuery, type ProjectSummary } from "@/lib/projects-api";

import { formatDay, formatMoment } from "../users/format";
import { AccessEditor } from "./access-editor";
import { accessSummary, DEFAULT_ACCESS } from "./access-text";

type Actor = { id: string; role: Role };

/** Whether `actor` may change, remove, or reset `target`: the API's rule (access/members.ts). */
function mayManage(actor: Actor, target: { id: string; role: Role }) {
  if (target.id === actor.id || target.role === "owner") return false;
  if (actor.role === "owner") return true;
  return actor.role === "admin" && target.role === "member";
}

/** Whether `actor` may renew or revoke an invitation: an admin's only the owner (access/invitations.ts). */
const mayActOnInvitation = (actor: Actor, invitation: Invitation) =>
  actor.role === "owner" || invitation.role === "member";

const ROLE_NAME: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member" };

function roleText(role: Role, access: Member["access"]) {
  return access === null ? ROLE_NAME[role] : `Member: ${accessSummary(access)}`;
}

/** "1 member", "3 members". */
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A link to copy and send, shown once: the API keeps only its hash. */
function LinkToSend({ url, about }: { url: string; about: string }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-ink-muted">{about}</p>
      <CopyableCode text={url} copyLabel="Copy the link" />
    </div>
  );
}

/**
 * An action behind a dialog: a button opens it, the action runs on
 * confirming, and a link it returns (an invitation's, a reset link) is shown
 * to copy, once.
 */
function ActionDialog({
  label,
  buttonLabel,
  title,
  description,
  confirmLabel,
  destructive = false,
  run,
  linkAbout,
  children,
  canConfirm = true,
  onClear,
  onDone,
}: {
  /** The button's text. */
  label: string;
  /** The button's accessible name, naming the person it acts on. */
  buttonLabel: string;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  run: () => Promise<{ url: string } | undefined>;
  linkAbout?: string;
  children?: React.ReactNode;
  canConfirm?: boolean;
  /** Clears what the form holds, such as a password: on closing, and after a failure. */
  onClear?: () => void;
  /** After an action that returns no link, once the dialog has closed. */
  onDone?: () => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const action = useMutation({
    mutationFn: run,
    onError: () => onClear?.(),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: membersKey });
      // Handing over ownership changes what the signed-in user may do.
      void queryClient.invalidateQueries({ queryKey: meQuery().queryKey });
      if (result === undefined) {
        setOpen(false);
        // Nothing the form held, such as a password, stays once the action is done.
        onClear?.();
        onDone?.();
      }
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          action.reset();
          onClear?.();
        }
      }}
    >
      <Button
        variant={destructive ? "destructive" : "outline"}
        className="self-start"
        aria-label={buttonLabel}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {action.data === undefined ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              action.mutate();
            }}
          >
            {children}
            {action.error !== null && (
              <Alert variant="destructive" role="alert">
                <OctagonAlertIcon />
                <AlertDescription>{action.error.message}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
              <Button
                type="submit"
                variant={destructive ? "destructive" : "default"}
                disabled={action.isPending || !canConfirm}
              >
                {action.isPending && (
                  <LoaderCircleIcon
                    aria-hidden="true"
                    className="animate-spin motion-reduce:animate-none"
                  />
                )}
                {confirmLabel}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <>
            <LinkToSend url={action.data.url} about={linkAbout ?? ""} />
            <DialogFooter>
              <DialogClose render={<Button type="button" />}>Done</DialogClose>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Whether a member's access can be saved: a chosen list needs a project. */
const choiceReady = (choice: AccessChoice) =>
  choice.role === "admin" || choice.access.projects === "all" || choice.access.projects.length > 0;

function InviteDialog({
  actor,
  projects,
  days,
}: {
  actor: Actor;
  projects: readonly ProjectSummary[];
  days: number;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [choice, setChoice] = React.useState<AccessChoice>({
    role: "member",
    access: DEFAULT_ACCESS,
  });
  const invite = useMutation({
    mutationFn: () => inviteMember(email.trim(), choice),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: membersKey }),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          invite.reset();
          setEmail("");
          setChoice({ role: "member", access: DEFAULT_ACCESS });
        }
      }}
    >
      <Button onClick={() => setOpen(true)}>
        <UserPlusIcon aria-hidden="true" />
        Invite
      </Button>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Invite someone</DialogTitle>
          <DialogDescription>
            Copy the invitation link. Send it to the person yourself. This instance sends no email.
            The link works once, for {days} days.
          </DialogDescription>
        </DialogHeader>
        {invite.data === undefined ? (
          <form
            className="flex flex-col gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              invite.mutate();
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="invite-email">Email</FieldLabel>
                <Input
                  id="invite-email"
                  type="email"
                  required
                  maxLength={320}
                  autoComplete="off"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </Field>
            </FieldGroup>
            <AccessEditor
              value={choice}
              onChange={setChoice}
              allowAdmin={actor.role === "owner"}
              projects={projects}
            />
            {invite.error !== null && (
              <Alert variant="destructive" role="alert">
                <OctagonAlertIcon />
                <AlertDescription>{invite.error.message}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
              <Button type="submit" disabled={invite.isPending || !choiceReady(choice)}>
                {invite.isPending && (
                  <LoaderCircleIcon
                    aria-hidden="true"
                    className="animate-spin motion-reduce:animate-none"
                  />
                )}
                Create invitation link
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <>
            <LinkToSend
              url={invite.data.url}
              about={`Send this link to ${invite.data.invitation.email}. The link appears only now. To replace a lost link, choose the invitation in the list and make a new link.`}
            />
            <DialogFooter>
              <DialogClose render={<Button type="button" />}>Done</DialogClose>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A choice compared by what it gives: the chosen projects in any order are the same. */
function comparable(choice: AccessChoice) {
  if (choice.role === "admin") return choice;
  const { projects } = choice.access;
  return {
    ...choice,
    access: { ...choice.access, projects: projects === "all" ? "all" : ignoreOrder(projects) },
  };
}

const NOT_READY = "Choose at least one project, or choose all projects.";

/**
 * A member's role and access, as a form under the save rule
 * (docs/design-system.md): Save waits for a change, Discard undoes it, and
 * leaving the page or choosing another person with it unsaved asks first.
 */
function AccessSection({
  member,
  actor,
  projects,
}: {
  member: Member;
  actor: Actor;
  projects: readonly ProjectSummary[];
}) {
  const queryClient = useQueryClient();
  const initial: AccessChoice =
    member.access === null ? { role: "admin" } : { role: "member", access: member.access };
  const form = useDirtyForm(
    { choice: initial },
    { key: member.id, normalize: { choice: comparable } },
  );
  const [notReady, setNotReady] = React.useState(false);
  const save = useMutation({
    mutationFn: (values: { choice: AccessChoice }) => changeMember(member.id, values.choice),
    onSuccess: (_, values) => {
      form.saved(values);
      void queryClient.invalidateQueries({ queryKey: membersKey });
    },
  });
  return (
    <SettingsSection
      title="Access"
      headingLevel={3}
      description="Changes apply on their next click."
      form={form}
      onSave={(values) => {
        const ready = choiceReady(values.choice);
        setNotReady(!ready);
        if (ready) save.mutate(values);
      }}
      saving={save.isPending}
      error={notReady && !choiceReady(form.values.choice) ? NOT_READY : save.error?.message}
      saveLabel="Save access"
    >
      <AccessEditor
        value={form.values.choice}
        onChange={(choice) => form.set("choice", choice)}
        allowAdmin={actor.role === "owner"}
        projects={projects}
      />
    </SettingsSection>
  );
}

/** Why the signed-in user cannot change this person, in the role rules' words. */
function whyNotManaged(actor: Actor, member: Member): string {
  if (member.id === actor.id) {
    return actor.role === "owner"
      ? "This is you. The owner keeps access to everything. To give the instance to someone else, choose them and hand over ownership."
      : "This is you. Nobody changes their own access or removes themselves here.";
  }
  if (member.role === "owner") {
    return "The owner has access to everything. Nobody else changes the owner's access, makes their reset link, or removes them.";
  }
  return "Only the owner changes an admin's access, makes their reset link, or removes them.";
}

/** One fact about a person: a term and its value, as a row. */
function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-1 py-2 text-sm">
      <dt className="text-ink-subtle">{term}</dt>
      <dd className="[overflow-wrap:anywhere] text-ink">{children}</dd>
    </div>
  );
}

/** A section of a person's actions without fields, under their name. */
function ActionSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <SettingsSection title={title} headingLevel={3} description={description} className="border-t">
      {children}
    </SettingsSection>
  );
}

function MemberDetail({
  member,
  actor,
  projects,
  timeZone,
  onGone,
}: {
  member: Member;
  actor: Actor;
  projects: readonly ProjectSummary[];
  timeZone: string | undefined;
  /** After the member is removed: says so, and leaves their page. */
  onGone: (notice: string, id: string) => void;
}) {
  const [password, setPassword] = React.useState("");
  const manage = mayManage(actor, member);
  return (
    <div className="flex flex-col">
      <header className="flex flex-col gap-1 pb-2">
        <h2
          tabIndex={-1}
          data-slot="person-heading"
          className="flex flex-wrap items-center gap-2 text-lg font-medium text-ink outline-none"
        >
          {member.name}
          {member.id === actor.id && <Badge variant="secondary">You</Badge>}
        </h2>
        <p className="text-sm [overflow-wrap:anywhere] text-ink-muted">{member.email}</p>
      </header>
      <dl className="flex max-w-2xl flex-col divide-y border-y">
        <Fact term="Role or access">{roleText(member.role, member.access)}</Fact>
        <Fact term="Last sign-in">
          {member.lastSignInAt === null ? "Never" : formatMoment(member.lastSignInAt, timeZone)}
        </Fact>
        <Fact term="Joined">{formatDay(member.createdAt, timeZone)}</Fact>
      </dl>
      {manage ? (
        <AccessSection member={member} actor={actor} projects={projects} />
      ) : (
        <p className="flex max-w-2xl items-start gap-2 py-6 text-sm text-ink-muted">
          <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {whyNotManaged(actor, member)}
        </p>
      )}
      {manage && (
        <ActionSection
          title="Password"
          description="A reset link works once, within 24 hours, to set a new password. Using it signs them out everywhere. Their old password works until then."
        >
          <ActionDialog
            label="Reset link"
            buttonLabel={`Make a reset link for ${member.name}`}
            title={`A reset link for ${member.name}`}
            description="The link works once, within 24 hours, to set a new password. Using it signs them out everywhere. Their old password works until then. A new link replaces the previous link."
            confirmLabel="Make the link"
            linkAbout={`Send this link to ${member.name}. It is shown only now.`}
            run={() => makeResetLink(member.id)}
          />
        </ActionSection>
      )}
      {actor.role === "owner" && member.id !== actor.id && (
        <ActionSection
          title="Ownership"
          description="The owner alone changes the instance settings and hands over ownership. Handing it over makes you an admin."
        >
          <ActionDialog
            label="Make owner"
            buttonLabel={`Make ${member.name} the owner`}
            title={`Make ${member.name} the owner?`}
            description="They gain access to the instance settings and everything else. You become an admin. Only the new owner can make you the owner again."
            confirmLabel="Hand over ownership"
            destructive
            canConfirm={password !== ""}
            onClear={() => setPassword("")}
            run={async () => {
              await handOverOwnership(member.id, password);
              return undefined;
            }}
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
        </ActionSection>
      )}
      {manage && (
        <ActionSection
          title="Remove"
          description="Removing deletes their account and signs them out at once. What they did, such as resolving errors, stays recorded."
        >
          <ActionDialog
            label="Remove"
            buttonLabel={`Remove ${member.name}`}
            title={`Remove ${member.name}?`}
            description="This deletes their account and signs them out immediately. Their actions, such as resolving errors, remain recorded. This also revokes their pending invitations."
            confirmLabel="Remove"
            destructive
            run={async () => {
              await removeMember(member.id);
              return undefined;
            }}
            onDone={() => onGone(`${member.name} was removed.`, member.id)}
          />
        </ActionSection>
      )}
    </div>
  );
}

function InvitationDetail({
  invitation,
  actor,
  now,
  days,
  timeZone,
  onGone,
}: {
  invitation: Invitation;
  actor: Actor;
  now: number;
  days: number;
  timeZone: string | undefined;
  onGone: (notice: string, id: string) => void;
}) {
  const expired = new Date(invitation.expiresAt).getTime() <= now;
  return (
    <div className="flex flex-col">
      <header className="flex flex-col gap-1 pb-2">
        <h2
          tabIndex={-1}
          data-slot="person-heading"
          className="text-lg font-medium [overflow-wrap:anywhere] text-ink outline-none"
        >
          {invitation.email}
        </h2>
        <p className="text-sm text-ink-muted">Invited, not joined yet</p>
      </header>
      <dl className="flex max-w-2xl flex-col divide-y border-y">
        <Fact term="Access">{roleText(invitation.role, invitation.access)}</Fact>
        <Fact term="Invited by">{invitation.invitedBy.name}</Fact>
        <Fact term="Invited">{formatMoment(invitation.createdAt, timeZone)}</Fact>
        <Fact term="Expires">
          {expired ? (
            <StatusBadge tone="warning">Expired</StatusBadge>
          ) : (
            formatMoment(invitation.expiresAt, timeZone)
          )}
        </Fact>
      </dl>
      {mayActOnInvitation(actor, invitation) ? (
        <>
          <ActionSection
            title="Link"
            description={`The link was shown once, when it was made. A new link works for ${days} days and stops the old one.`}
          >
            <ActionDialog
              label="New link"
              buttonLabel={`Make a new link for ${invitation.email}`}
              title={`A new link for ${invitation.email}`}
              description={`The old link stops working. The new link works for ${days} days. Use this to replace a lost link, which cannot be shown again.`}
              confirmLabel="Make a new link"
              linkAbout={`Send this link to ${invitation.email}. It is shown only now.`}
              run={() => renewInvitation(invitation.id)}
            />
          </ActionSection>
          <ActionSection title="Revoke" description="Revoking stops the link at once.">
            <ActionDialog
              label="Revoke"
              buttonLabel={`Revoke the invitation of ${invitation.email}`}
              title={`Revoke the invitation of ${invitation.email}?`}
              description="Its link stops working at once."
              confirmLabel="Revoke"
              destructive
              run={async () => {
                await revokeInvitation(invitation.id);
                return undefined;
              }}
              onDone={() =>
                onGone(`The invitation of ${invitation.email} was revoked.`, invitation.id)
              }
            />
          </ActionSection>
        </>
      ) : (
        <p className="flex max-w-2xl items-start gap-2 py-6 text-sm text-ink-muted">
          <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          Only the owner renews or revokes an invitation to be an admin.
        </p>
      )}
    </div>
  );
}

/** The detail pane with nobody chosen: who has access, and what the page is for. */
function Summary({
  members,
  invitations,
  days,
}: {
  members: readonly Member[];
  invitations: readonly Invitation[];
  days: number;
}) {
  const of = (role: Role) => members.filter((member) => member.role === role).length;
  const figures = [
    { label: "Owner", value: of("owner") },
    { label: "Admins", value: of("admin") },
    { label: "Members", value: of("member") },
    { label: "Pending invitations", value: invitations.length },
  ];
  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <h2 className="text-base font-medium text-ink">Everyone with access</h2>
      <dl className="grid grid-cols-2 gap-px overflow-hidden border-y sm:grid-cols-4">
        {figures.map((figure) => (
          <div key={figure.label} className="flex flex-col gap-1 py-3 pr-4">
            <dt className="text-xs text-ink-subtle">{figure.label}</dt>
            <dd className="text-xl font-medium text-ink tabular-nums">{figure.value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm text-pretty text-ink-muted">
        The owner and admins have access to everything. Members have access to their assigned areas
        and projects. Changes apply on the next click.
      </p>
      <p className="text-sm text-pretty text-ink-muted">
        Each invitation link works once, for {days} days. Removing or demoting an admin revokes the
        invitations they made.
      </p>
      <p className="text-sm text-ink-subtle">
        Choose a person to change their access, make a reset link, or remove them.
      </p>
    </div>
  );
}

/**
 * A person's name or email in the list, as a link that chooses them. The
 * chosen one is the router's active link, marked `aria-current="page"`.
 */
function ChooseLink({
  search,
  children,
}: {
  search: { member?: string; invitation?: string };
  children: React.ReactNode;
}) {
  return (
    <Link
      to="/settings/members"
      search={search}
      data-person={search.member ?? search.invitation}
      className="truncate font-medium text-link hover:underline"
    >
      {children}
    </Link>
  );
}

function PeopleList({
  members,
  invitations,
  actor,
  chosen,
  now,
  timeZone,
}: {
  members: readonly Member[];
  invitations: readonly Invitation[];
  actor: Actor;
  chosen: { member: string | undefined; invitation: string | undefined };
  now: number;
  timeZone: string | undefined;
}) {
  // A phone leaves out what the person's page shows: the last sign-in, when an invitation expires.
  const phone = useMediaQuery(PHONE);
  return (
    <div className="flex flex-col gap-6 pb-6">
      <section aria-labelledby="members-list-title" className="flex flex-col gap-1">
        <h2
          id="members-list-title"
          tabIndex={-1}
          className="px-gutter text-sm font-medium text-ink outline-none"
        >
          Members
        </h2>
        <Table className="table-fixed">
          <caption className="sr-only">Members</caption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead scope="col" className={`${LIST_HEAD} ${GUTTER_START} w-[45%]`}>
                Name
              </TableHead>
              <TableHead scope="col" className={`${LIST_HEAD} ${phone ? GUTTER_END : ""}`}>
                Role or access
              </TableHead>
              {!phone && (
                <TableHead scope="col" className={`${LIST_HEAD} ${GUTTER_END} w-36`}>
                  Last sign-in
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => {
              const isChosen = chosen.member === member.id;
              return (
                <TableRow
                  key={member.id}
                  data-state={isChosen ? "selected" : undefined}
                  className={SELECTED_ROW}
                >
                  <TableCell className={`${GUTTER_START} py-2.5 whitespace-normal`}>
                    <div className="flex min-w-0 items-center gap-2">
                      <ChooseLink search={{ member: member.id }}>{member.name}</ChooseLink>
                      {member.id === actor.id && <Badge variant="secondary">You</Badge>}
                    </div>
                    <p className="truncate text-xs text-ink-subtle" title={member.email}>
                      {member.email}
                    </p>
                  </TableCell>
                  <TableCell
                    className={`truncate text-ink-muted ${phone ? GUTTER_END : ""}`}
                    title={roleText(member.role, member.access)}
                  >
                    {roleText(member.role, member.access)}
                  </TableCell>
                  {!phone && (
                    <TableCell className={`${GUTTER_END} text-ink-muted tabular-nums`}>
                      {member.lastSignInAt === null
                        ? "Never"
                        : formatDay(member.lastSignInAt, timeZone)}
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </section>
      <section aria-labelledby="invitations-list-title" className="flex flex-col gap-1">
        <h2
          id="invitations-list-title"
          tabIndex={-1}
          className="px-gutter text-sm font-medium text-ink outline-none"
        >
          Pending invitations
        </h2>
        {invitations.length === 0 ? (
          <p className="px-gutter py-2 text-sm text-ink-subtle">No pending invitations.</p>
        ) : (
          <Table className="table-fixed">
            <caption className="sr-only">Pending invitations</caption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col" className={`${LIST_HEAD} ${GUTTER_START} w-[45%]`}>
                  Email
                </TableHead>
                <TableHead scope="col" className={`${LIST_HEAD} ${phone ? GUTTER_END : ""}`}>
                  Access
                </TableHead>
                {!phone && (
                  <TableHead scope="col" className={`${LIST_HEAD} ${GUTTER_END} w-36`}>
                    Expires
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {invitations.map((invitation) => {
                const isChosen = chosen.invitation === invitation.id;
                return (
                  <TableRow
                    key={invitation.id}
                    data-state={isChosen ? "selected" : undefined}
                    className={SELECTED_ROW}
                  >
                    <TableCell className={`${GUTTER_START} py-2.5`}>
                      <div className="flex min-w-0">
                        <ChooseLink search={{ invitation: invitation.id }}>
                          {invitation.email}
                        </ChooseLink>
                      </div>
                    </TableCell>
                    <TableCell
                      className={`truncate text-ink-muted ${phone ? GUTTER_END : ""}`}
                      title={roleText(invitation.role, invitation.access)}
                    >
                      {roleText(invitation.role, invitation.access)}
                    </TableCell>
                    {!phone && (
                      <TableCell className={`${GUTTER_END} text-ink-muted tabular-nums`}>
                        {new Date(invitation.expiresAt).getTime() <= now ? (
                          <StatusBadge tone="warning">Expired</StatusBadge>
                        ) : (
                          formatDay(invitation.expiresAt, timeZone)
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}

/** The two panes' shape while the members load. */
function MembersSkeleton() {
  return (
    <div
      className="grid min-[64rem]:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]"
      aria-busy="true"
      aria-label="Loading members"
    >
      <div className="flex flex-col gap-3 px-gutter py-4 min-[64rem]:border-r">
        <Skeleton className="h-8 w-24 self-end" />
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-10 w-full" />
        ))}
      </div>
      <div className="hidden flex-col gap-4 px-gutter py-6 min-[64rem]:flex">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-16 w-full max-w-2xl" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>
    </div>
  );
}

/**
 * The Members page (/settings/members; docs/access.md), a list with the
 * chosen person beside it (`?member=` or `?invitation=`): members with their
 * role or access and last sign-in, and pending invitations. The owner and
 * admins invite, change access, remove, and make reset links, within the
 * role rules; the owner hands over ownership. Under 64rem the list and a
 * person's page take the screen in turn.
 */
export function MembersPage({
  chosen,
}: {
  /** The person chosen in the address: a member's ID, or an invitation's. */
  chosen: { member: string | undefined; invitation: string | undefined };
}) {
  const me = useQuery(meQuery());
  const allowed = me.data?.permissions.members === true;
  const members = useQuery({ ...membersQuery(), enabled: allowed });
  const projects = useQuery({ ...projectsQuery(), enabled: allowed });
  const navigate = useNavigate();
  const narrow = useMediaQuery(NARROW_WORKBENCH);
  // When the page opened: invitations past it show as expired.
  const [now] = React.useState(() => Date.now());
  // What the last removal or revocation did, and the choice it left: shown until the next one.
  const [notice, setNotice] = React.useState<{
    text: string;
    after: string;
    seen: boolean;
  } | null>(null);
  // Where focus goes once the next person (or the list) has rendered.
  const [focusTarget, setFocusTarget] = React.useState<string | null>(null);
  const chosenKey = JSON.stringify([chosen.member ?? null, chosen.invitation ?? null]);
  // Shown once the address holds the choice the removal left, and gone at the next choice:
  // adjusted while rendering, as the address changes.
  if (notice !== null && notice.after === chosenKey && !notice.seen) {
    setNotice({ ...notice, seen: true });
  } else if (notice !== null && notice.after !== chosenKey && notice.seen) {
    setNotice(null);
  }
  const shownNotice = notice !== null && notice.after === chosenKey ? notice.text : "";

  // Once the address holds the choice the removal left, and it has rendered.
  const arrived = notice !== null && notice.after === chosenKey;
  React.useEffect(() => {
    if (focusTarget === null || !arrived) return undefined;
    const frame = requestAnimationFrame(() => {
      const target = focusTarget.startsWith("#")
        ? document.querySelector<HTMLElement>(focusTarget)
        : narrow
          ? document.querySelector<HTMLElement>("[data-slot=person-heading]")
          : document.querySelector<HTMLElement>(`[data-person="${CSS.escape(focusTarget)}"]`);
      target?.focus();
      setFocusTarget(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusTarget, narrow, arrived]);

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
  const member = data.members.find((item) => item.id === chosen.member);
  const invitation = data.invitations.find((item) => item.id === chosen.invitation);
  const anyChosen = chosen.member !== undefined || chosen.invitation !== undefined;

  // The person is gone: the one after them in their list is chosen (the one before, at the
  // end), with focus on their row, without asking about the form that went with them. With
  // nobody left in that list, focus goes to its heading.
  const leavePerson = (text: string, id: string) => {
    const kind = data.members.some((item) => item.id === id) ? "member" : "invitation";
    const ids = (kind === "member" ? data.members : data.invitations).map((item) => item.id);
    const at = ids.indexOf(id);
    const rest = ids.filter((item) => item !== id);
    // Nobody acts on themselves or the owner, but they can still be chosen.
    const next = rest[Math.min(at, rest.length - 1)];
    const search = next === undefined ? {} : { [kind]: next };
    setNotice({
      text,
      seen: false,
      after: JSON.stringify([
        kind === "member" ? (next ?? null) : null,
        kind === "invitation" ? (next ?? null) : null,
      ]),
    });
    setFocusTarget(next ?? (kind === "member" ? "#members-list-title" : "#invitations-list-title"));
    void navigate({ to: "/settings/members", search, ignoreBlocker: true });
  };

  const detail = (() => {
    if (member !== undefined) {
      return (
        <MemberDetail
          key={member.id}
          member={member}
          actor={actor}
          projects={projects.data}
          timeZone={timeZone}
          onGone={leavePerson}
        />
      );
    }
    if (invitation !== undefined) {
      return (
        <InvitationDetail
          key={invitation.id}
          invitation={invitation}
          actor={actor}
          now={now}
          days={data.invitationDays}
          timeZone={timeZone}
          onGone={leavePerson}
        />
      );
    }
    if (anyChosen) {
      return (
        <div className="flex max-w-2xl flex-col items-start gap-3">
          <h2 className="text-base font-medium text-ink">Nobody here has this link</h2>
          <p className="text-sm text-ink-muted">
            The person was removed, the invitation was used or revoked, or the link is mistyped.
          </p>
        </div>
      );
    }
    return (
      <Summary members={data.members} invitations={data.invitations} days={data.invitationDays} />
    );
  })();

  const toolbar = (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b px-gutter py-3">
      <p className="text-sm text-ink-subtle">
        {count(data.members.length, "person", "people")},{" "}
        {count(data.invitations.length, "pending invitation", "pending invitations")}
      </p>
      <InviteDialog actor={actor} projects={projects.data} days={data.invitationDays} />
    </div>
  );
  const list = (
    <PeopleList
      members={data.members}
      invitations={data.invitations}
      actor={actor}
      chosen={chosen}
      now={now}
      timeZone={timeZone}
    />
  );

  // One tree at every width, so crossing 64rem (a tablet turned) keeps the open dialogs and the
  // unsaved access: CSS shows both panes from 64rem, and under it the list or the person.
  return (
    <UnsavedChangesGuard searchKeys={["member"]}>
      <output
        aria-live="polite"
        data-slot="members-notice"
        className="block border-b px-gutter py-3 text-sm text-ink empty:border-0 empty:p-0"
      >
        {shownNotice}
      </output>
      <div className="grid min-[64rem]:min-h-full min-[64rem]:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div
          data-slot="members-list"
          className={cn("flex flex-col min-[64rem]:border-r", anyChosen && "max-[64rem]:hidden")}
        >
          {toolbar}
          <div className="pt-4">{list}</div>
        </div>
        <div
          data-slot="members-detail"
          className={cn(
            "flex flex-col px-gutter py-4 min-[64rem]:py-6",
            !anyChosen && "max-[64rem]:hidden",
          )}
        >
          {anyChosen && (
            <Link
              to="/settings/members"
              search={{}}
              activeOptions={{ exact: true, includeSearch: true }}
              className="mb-4 inline-flex items-center gap-1 self-start text-sm text-link hover:underline min-[64rem]:hidden"
            >
              <ArrowLeftIcon aria-hidden="true" className="size-4" />
              All members
            </Link>
          )}
          {detail}
        </div>
      </div>
    </UnsavedChangesGuard>
  );
}
