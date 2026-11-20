import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoaderCircleIcon, OctagonAlertIcon, UserPlusIcon } from "lucide-react";
import * as React from "react";

import { CopyableCode } from "@/components/copyable-code";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ignoreOrder, useDirtyForm } from "@/hooks/use-dirty-form";
import { meQuery, type Role } from "@/lib/access";
import {
  type AccessChoice,
  changeMember,
  inviteMember,
  type Member,
  membersKey,
} from "@/lib/members-api";
import type { ProjectSummary } from "@/lib/projects-api";

import { AccessEditor } from "./access-editor";
import { DEFAULT_ACCESS } from "./access-text";

export type Actor = { id: string; role: Role };

/** Where focus goes when a dialog or the sheet closes: the element, or the default. */
export type FinalFocus = () => HTMLElement | true;

/** Why a link can't be shown twice, and what to do when it is lost. */
export const LINK_ONCE =
  "Copy it now: Ottertrail keeps only a fingerprint of the link, so it can't show it again.";

/** A link to copy and send, shown once: the API keeps only its hash. */
function LinkToSend({ url, about }: { url: string; about: string }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-pretty text-ink-muted">{about}</p>
      <CopyableCode text={url} copyLabel="Copy the link" />
    </div>
  );
}

/**
 * An action behind a confirmation, opened from a row's menu: the action runs
 * on confirming, and a link it returns (an invitation's, a reset link) is
 * shown to copy, once.
 */
export function ActionDialog({
  open,
  onOpenChange,
  finalFocus,
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
  open: boolean;
  onOpenChange: (open: boolean) => void;
  finalFocus: FinalFocus;
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
  /** After an action that returns no link, as the dialog closes. */
  onDone?: () => void;
}) {
  const queryClient = useQueryClient();
  const action = useMutation({
    mutationFn: run,
    onError: () => onClear?.(),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: membersKey });
      // Handing over ownership changes what the signed-in user may do.
      void queryClient.invalidateQueries({ queryKey: meQuery().queryKey });
      if (result === undefined) {
        // Nothing the form held, such as a password, stays once the action is done.
        onClear?.();
        onDone?.();
        onOpenChange(false);
      }
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) onClear?.();
      }}
    >
      <DialogContent className="sm:max-w-lg" finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="text-pretty">{description}</DialogDescription>
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

const NOT_READY = "Choose at least one project, or choose all projects.";

/** Invite: the button at the top of the page, and its dialog. */
export function InviteDialog({
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
          <DialogDescription className="text-pretty">
            Ottertrail doesn't email invitations, since many self-hosted servers have no mail server
            set up. Copy the link and send it to the person yourself, for example in a chat or an
            email. The link works once, within {days} days.
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
              about={`Send this link to ${invite.data.invitation.email}. ${LINK_ONCE} If it gets lost, choose New link in the invitation's menu on the Invitations tab.`}
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

/**
 * Change access: a member's role and access in a sheet, under the save rule
 * (docs/design-system.md). Save waits for a change and closes the sheet once
 * saved; closing with unsaved changes (Cancel, Escape, the close button, a
 * click outside) asks first, and so does leaving the page.
 */
export function AccessSheet({
  member,
  actor,
  projects,
  open,
  onOpenChange,
  finalFocus,
  onSaved,
}: {
  member: Member;
  actor: Actor;
  projects: readonly ProjectSummary[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  finalFocus: FinalFocus;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const initial: AccessChoice =
    member.access === null ? { role: "admin" } : { role: "member", access: member.access };
  const form = useDirtyForm(
    { choice: initial },
    { key: member.id, normalize: { choice: comparable } },
  );
  const [notReady, setNotReady] = React.useState(false);
  const [asking, setAsking] = React.useState(false);
  const save = useMutation({
    mutationFn: (values: { choice: AccessChoice }) => changeMember(member.id, values.choice),
    onSuccess: (_, values) => {
      form.saved(values);
      void queryClient.invalidateQueries({ queryKey: membersKey });
      onSaved();
      onOpenChange(false);
    },
  });
  const close = () => {
    if (save.isPending) return;
    if (form.dirty) setAsking(true);
    else onOpenChange(false);
  };
  const error = notReady && !choiceReady(form.values.choice) ? NOT_READY : save.error?.message;
  const status = save.isPending ? "Saving…" : form.dirty ? "Unsaved changes" : "No unsaved changes";
  const demoting = member.role === "admin" && form.values.choice.role === "member";
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else close();
      }}
    >
      <SheetContent
        side="right"
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
        finalFocus={finalFocus}
      >
        <form
          aria-label="Access"
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (!form.dirty || save.isPending) return;
            const ready = choiceReady(form.values.choice);
            setNotReady(!ready);
            if (ready) save.mutate(form.values);
          }}
        >
          <SheetHeader className="border-b pr-12">
            <SheetTitle>Change access for {member.name}</SheetTitle>
            <SheetDescription className="text-pretty text-ink-subtle">
              {member.email}. Changes apply the next time they click anything in Ottertrail, so they
              don't need to sign out and back in.
            </SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
            <AccessEditor
              value={form.values.choice}
              onChange={(choice) => form.set("choice", choice)}
              allowAdmin={actor.role === "owner"}
              projects={projects}
            />
            {demoting && (
              <p className="text-sm text-pretty text-ink-muted">
                Making {member.name} a member revokes the invitations they sent, because a member
                can't invite anyone. Their invitees need a new invitation from you.
              </p>
            )}
            {form.conflict && (
              <Alert role="alert">
                <OctagonAlertIcon />
                <AlertTitle>Their access changed while you edited it</AlertTitle>
                <AlertDescription>
                  Someone else saved a change. Your edits are kept; save to replace theirs, or load
                  the new values to start again from them.
                </AlertDescription>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2 justify-self-start"
                  onClick={() => form.discard()}
                >
                  Load the new values
                </Button>
              </Alert>
            )}
            {error !== undefined && (
              <Alert variant="destructive" role="alert">
                <OctagonAlertIcon />
                <AlertTitle>The changes were not saved</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>
          <SheetFooter className="mt-0 flex-row flex-wrap items-center gap-2 border-t">
            <output aria-live="polite" className="mr-auto text-sm text-ink-subtle">
              {status}
            </output>
            <Button type="button" variant="outline" onClick={close} disabled={save.isPending}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!form.dirty || save.isPending}
              focusableWhenDisabled
              aria-busy={save.isPending || undefined}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </SheetFooter>
        </form>
        <Dialog open={asking} onOpenChange={setAsking}>
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>Discard your changes?</DialogTitle>
              <DialogDescription className="text-pretty">
                Your changes to {member.name}'s access aren't saved yet. If you close, they're lost
                and their access stays as it was.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" type="button" />}>
                Keep editing
              </DialogClose>
              <Button
                variant="destructive"
                onClick={() => {
                  form.discard();
                  setAsking(false);
                  onOpenChange(false);
                }}
              >
                Discard changes
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SheetContent>
    </Sheet>
  );
}
