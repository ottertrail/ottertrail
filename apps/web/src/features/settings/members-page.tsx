import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircleIcon, OctagonAlertIcon, UserPlusIcon } from "lucide-react";
import * as React from "react";

import { CopyableCode } from "@/components/copyable-code";
import { NoAccess } from "@/components/no-access";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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

import { formatMoment } from "../users/format";
import { AccessEditor } from "./access-editor";
import { accessSummary, DEFAULT_ACCESS } from "./access-text";

type Actor = { id: string; role: Role };

/** Whether `actor` may change, remove, or reset `target`: the API's rule (access/members.ts). */
function mayManage(actor: Actor, target: { id: string; role: Role }) {
  if (target.id === actor.id || target.role === "owner") return false;
  if (actor.role === "owner") return true;
  return actor.role === "admin" && target.role === "member";
}

const ROLE_NAME: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member" };

function roleText(role: Role, access: Member["access"]) {
  return access === null ? ROLE_NAME[role] : `Member: ${accessSummary(access)}`;
}

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
 * A row's action behind a dialog: a button opens it, the action runs on
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
}: {
  /** The button's text. */
  label: string;
  /** The button's accessible name, naming its row. */
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
      if (result === undefined) setOpen(false);
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
      <Button variant="ghost" size="sm" aria-label={buttonLabel} onClick={() => setOpen(true)}>
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
                  <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
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
            You get a link to copy and send them yourself: this instance sends no email. It works
            once, for {days} days.
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
                  <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
                )}
                Create invitation link
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <>
            <LinkToSend
              url={invite.data.url}
              about={`Send this link to ${invite.data.invitation.email}. It is shown only now; "New link" on this page replaces it if it is lost.`}
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

function MemberActions({
  member,
  actor,
  projects,
}: {
  member: Member;
  actor: Actor;
  projects: readonly ProjectSummary[];
}) {
  const [choice, setChoice] = React.useState<AccessChoice>(
    member.access === null ? { role: "admin" } : { role: "member", access: member.access },
  );
  const [password, setPassword] = React.useState("");
  const manage = mayManage(actor, member);
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {manage && (
        <ActionDialog
          label="Change access"
          buttonLabel={`Change the access of ${member.name}`}
          title={`Change the access of ${member.name}`}
          description="It applies on their next click."
          confirmLabel="Save access"
          canConfirm={choiceReady(choice)}
          run={async () => {
            await changeMember(member.id, choice);
            return undefined;
          }}
        >
          <AccessEditor
            value={choice}
            onChange={setChoice}
            allowAdmin={actor.role === "owner"}
            projects={projects}
          />
        </ActionDialog>
      )}
      {manage && (
        <ActionDialog
          label="Reset link"
          buttonLabel={`Make a reset link for ${member.name}`}
          title={`A reset link for ${member.name}`}
          description="The link sets a new password, once, within 24 hours. Using it signs them out everywhere; their old password works until then. A new link replaces an earlier one."
          confirmLabel="Make the link"
          linkAbout={`Send this link to ${member.name}. It is shown only now.`}
          run={() => makeResetLink(member.id)}
        />
      )}
      {actor.role === "owner" && member.id !== actor.id && (
        <ActionDialog
          label="Make owner"
          buttonLabel={`Make ${member.name} the owner`}
          title={`Make ${member.name} the owner?`}
          description="They get the instance's settings and everything else. You become an admin, and only they can make you the owner again."
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
      )}
      {manage && (
        <ActionDialog
          label="Remove"
          buttonLabel={`Remove ${member.name}`}
          title={`Remove ${member.name}?`}
          description="Their account is deleted and they are signed out at once. What they did stays, such as errors they resolved. Their pending invitations are revoked."
          confirmLabel="Remove"
          destructive
          run={async () => {
            await removeMember(member.id);
            return undefined;
          }}
        />
      )}
    </div>
  );
}

function InvitationActions({ invitation, actor }: { invitation: Invitation; actor: Actor }) {
  if (actor.role !== "owner" && invitation.role !== "member") return null;
  return (
    <div className="flex flex-wrap justify-end gap-1">
      <ActionDialog
        label="New link"
        buttonLabel={`Make a new link for ${invitation.email}`}
        title={`A new link for ${invitation.email}`}
        description="The old link stops working, and the new one works for 7 days. The link cannot be shown again, so this replaces a lost one."
        confirmLabel="Make a new link"
        linkAbout={`Send this link to ${invitation.email}. It is shown only now.`}
        run={() => renewInvitation(invitation.id)}
      />
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
      />
    </div>
  );
}

/**
 * The Members page (/settings/members; docs/access.md): everyone with their
 * role or access and last sign-in, and pending invitations. The owner and
 * admins invite, change access, remove, and make reset links, within the
 * role rules; the owner hands over ownership.
 */
export function MembersPage() {
  const me = useQuery(meQuery());
  const allowed = me.data?.permissions.members === true;
  const members = useQuery({ ...membersQuery(), enabled: allowed });
  const projects = useQuery({ ...projectsQuery(), enabled: allowed });
  // When the page opened: invitations past it show as expired.
  const [now] = React.useState(() => Date.now());

  if (me.data !== undefined && !allowed) {
    return <NoAccess />;
  }
  const data = members.data;
  const timeZone = me.data?.instance.timeZone;
  if (members.isError) {
    return (
      <div className="mx-auto max-w-5xl p-6">
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>Members could not load</AlertTitle>
          <AlertDescription>{members.error.message}</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => void members.refetch()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      </div>
    );
  }
  if (data === undefined || projects.data === undefined) {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-4 p-6" aria-busy="true">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  const actor = data.you;
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <h3>Members</h3>
          </CardTitle>
          <CardDescription>
            The owner and admins reach everything; a member reaches the areas and projects they were
            given. Changes apply on the next click.
          </CardDescription>
          <CardAction>
            <InviteDialog actor={actor} projects={projects.data} days={data.invitationDays} />
          </CardAction>
        </CardHeader>
        <CardContent>
          <Table>
            <caption className="sr-only">Members</caption>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role or access</TableHead>
                <TableHead>Last sign-in</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.members.map((member) => (
                <TableRow key={member.id}>
                  <TableCell className="font-medium">
                    {member.name}
                    {member.id === actor.id && (
                      <Badge variant="secondary" className="ml-2">
                        You
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-ink-muted">{member.email}</TableCell>
                  <TableCell>{roleText(member.role, member.access)}</TableCell>
                  <TableCell className="text-ink-muted">
                    {member.lastSignInAt === null
                      ? "Never"
                      : formatMoment(member.lastSignInAt, timeZone)}
                  </TableCell>
                  <TableCell>
                    <MemberActions member={member} actor={actor} projects={projects.data} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h3>Pending invitations</h3>
          </CardTitle>
          <CardDescription>
            Each link works once, for {data.invitationDays} days. Removing or demoting an admin
            revokes the invitations they made.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.invitations.length === 0 ? (
            <p className="text-sm text-ink-subtle">No pending invitations.</p>
          ) : (
            <Table>
              <caption className="sr-only">Pending invitations</caption>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Access</TableHead>
                  <TableHead>Invited by</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.invitations.map((invitation) => (
                  <TableRow key={invitation.id}>
                    <TableCell className="font-medium">{invitation.email}</TableCell>
                    <TableCell>{roleText(invitation.role, invitation.access)}</TableCell>
                    <TableCell className="text-ink-muted">{invitation.invitedBy.name}</TableCell>
                    <TableCell>
                      {new Date(invitation.expiresAt).getTime() <= now ? (
                        <StatusBadge tone="warning">Expired</StatusBadge>
                      ) : (
                        <span className="text-ink-muted">
                          {formatMoment(invitation.expiresAt, timeZone)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <InvitationActions invitation={invitation} actor={actor} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
