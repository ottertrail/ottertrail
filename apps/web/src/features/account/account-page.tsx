import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircleIcon, MonitorSmartphoneIcon, OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { SettingsSection } from "@/components/settings-section";
import { type SettingsTab, SettingsTabs } from "@/components/settings-tabs";
import { TruncatedText } from "@/components/truncated-text";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useDirtyForm } from "@/hooks/use-dirty-form";
import { meQuery } from "@/lib/access";
import {
  type AccountSession,
  accountSessionsQuery,
  changeEmail,
  changePassword,
  MAX_NAME_LENGTH,
  deviceName,
  revokeOtherSessions,
  revokeSession,
  updateName,
} from "@/lib/account-api";
import { ApiError } from "@/lib/api";

import { MIN_PASSWORD_LENGTH } from "../auth/link-token";
import { SectionFailed, SectionSkeleton } from "../settings/section-states";
import { formatDay, formatMoment } from "../users/format";

const PASSWORDS_DIFFER = "The passwords do not match. Enter the same password in both fields.";

/** One line said after a change, until the next: a polite live region, always mounted. */
function Notice({ children }: { children: React.ReactNode }) {
  return <output className="block text-sm text-success empty:hidden">{children}</output>;
}

/**
 * After the account changed: the session (the sidebar's name and email)
 * and everything that names the user (GET /api/me, the Members page) are
 * read again.
 */
function useAccountChanged() {
  const queryClient = useQueryClient();
  return React.useCallback(() => queryClient.invalidateQueries(), [queryClient]);
}

function NameForm({ name, onDirty }: { name: string; onDirty: (dirty: boolean) => void }) {
  const changed = useAccountChanged();
  const form = useDirtyForm({ name }, { normalize: { name: (value) => value.trim() } });
  React.useEffect(() => onDirty(form.dirty), [onDirty, form.dirty]);
  const save = useMutation({
    mutationFn: (values: { name: string }) => updateName(values.name.trim()),
    onSuccess: async (user, values) => {
      form.saved(values);
      await changed();
      form.set("name", user.name);
    },
  });
  return (
    <SettingsSection
      title="Name"
      description="Your teammates see it on the Members page and beside what you resolve."
      form={form}
      onSave={(values) => save.mutate(values)}
      saving={save.isPending}
      error={save.error?.message}
      saveLabel="Save name"
    >
      <Field>
        <FieldLabel htmlFor="account-name">Name</FieldLabel>
        <Input
          id="account-name"
          name="name"
          value={form.values.name}
          onChange={(event) => form.set("name", event.target.value)}
          required
          pattern=".*\S.*"
          maxLength={MAX_NAME_LENGTH}
          autoComplete="name"
        />
      </Field>
    </SettingsSection>
  );
}

interface EmailValues {
  email: string;
  password: string;
}

/** Which field an email change's refusal is about. */
function emailErrorField(error: Error | null): "email" | "password" | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === "wrong_password") return "password";
  if (["email_in_use", "invalid_email", "same_email"].includes(error.code ?? "")) return "email";
  return null;
}

function EmailForm({ email, onDirty }: { email: string; onDirty: (dirty: boolean) => void }) {
  const changed = useAccountChanged();
  const [notice, setNotice] = React.useState("");
  // The password is asked for each change; typing it alone changes nothing to save.
  const form = useDirtyForm<EmailValues>(
    { email, password: "" },
    { normalize: { email: (value) => value.trim().toLowerCase(), password: () => "" } },
  );
  React.useEffect(() => onDirty(form.dirty), [onDirty, form.dirty]);
  const save = useMutation({
    mutationFn: (values: EmailValues) => changeEmail(values.email.trim(), values.password),
    onMutate: () => setNotice(""),
    onSuccess: async (user) => {
      form.saved({ email: user.email, password: "" });
      form.setValues({ email: user.email, password: "" });
      setNotice(`Your email is now ${user.email}. Sign in with it from now on.`);
      await changed();
    },
  });
  const field = emailErrorField(save.error);
  const fieldError = (name: "email" | "password") =>
    field === name && save.error !== null ? (
      <FieldError id={`account-${name}-error`}>{save.error.message}</FieldError>
    ) : null;
  return (
    <SettingsSection
      title="Email"
      description={
        <>
          <p>You sign in with this address. A new address works at once.</p>
          <p className="mt-1">
            Ottertrail doesn't send a confirmation email, because most self-hosted servers have no
            mail set up. Check the new address: you'll sign in with it from now on.
          </p>
        </>
      }
      form={form}
      onSave={(values) => save.mutate(values)}
      saving={save.isPending}
      error={field === null ? save.error?.message : undefined}
      saveLabel="Change email"
    >
      <FieldGroup>
        <Field data-invalid={field === "email" || undefined}>
          <FieldLabel htmlFor="account-email">Email</FieldLabel>
          <Input
            id="account-email"
            name="email"
            type="email"
            value={form.values.email}
            onChange={(event) => form.set("email", event.target.value)}
            required
            maxLength={320}
            autoComplete="email"
            aria-invalid={field === "email" || undefined}
            aria-describedby={field === "email" ? "account-email-error" : undefined}
          />
          {fieldError("email")}
        </Field>
        <Field data-invalid={field === "password" || undefined}>
          <FieldLabel htmlFor="account-email-password">Current password</FieldLabel>
          <Input
            id="account-email-password"
            name="password"
            type="password"
            value={form.values.password}
            onChange={(event) => form.set("password", event.target.value)}
            required={form.dirty}
            maxLength={128}
            autoComplete="current-password"
            aria-invalid={field === "password" || undefined}
            aria-describedby={
              field === "password" ? "account-password-error" : "account-email-password-hint"
            }
          />
          {fieldError("password") ?? (
            <FieldDescription id="account-email-password-hint">
              Asked each time, so nobody at an unlocked screen can take over your account.
            </FieldDescription>
          )}
        </Field>
        <Notice>{notice}</Notice>
      </FieldGroup>
    </SettingsSection>
  );
}

interface PasswordValues {
  currentPassword: string;
  password: string;
  confirmPassword: string;
  revokeOtherSessions: boolean;
}

const NO_PASSWORDS: PasswordValues = {
  currentPassword: "",
  password: "",
  confirmPassword: "",
  revokeOtherSessions: true,
};

function PasswordTab({ onDirty }: { onDirty: (dirty: boolean) => void }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = React.useState("");
  const [differ, setDiffer] = React.useState(false);
  // The checkbox alone is nothing to save.
  const form = useDirtyForm(NO_PASSWORDS, { normalize: { revokeOtherSessions: () => true } });
  React.useEffect(() => onDirty(form.dirty), [onDirty, form.dirty]);
  const save = useMutation({
    mutationFn: (values: PasswordValues) => changePassword(values),
    onMutate: () => setNotice(""),
    onSuccess: async (_, values) => {
      form.discard();
      setNotice(
        values.revokeOtherSessions
          ? "Your password is changed, and your other devices are signed out."
          : "Your password is changed.",
      );
      // Signing out the others gave this browser a new session.
      await queryClient.invalidateQueries({ queryKey: accountSessionsQuery().queryKey });
    },
  });
  const wrong = save.error instanceof ApiError && save.error.code === "wrong_password";
  return (
    <SettingsSection
      title="Password"
      description={`At least ${MIN_PASSWORD_LENGTH} characters. A passphrase of a few words works well.`}
      form={form}
      onSave={(values) => {
        if (values.password !== values.confirmPassword) {
          setDiffer(true);
          return;
        }
        save.mutate(values);
      }}
      saving={save.isPending}
      error={wrong || save.error === null ? undefined : save.error.message}
      saveLabel="Change password"
    >
      <FieldGroup>
        <Field data-invalid={wrong || undefined}>
          <FieldLabel htmlFor="account-current-password">Current password</FieldLabel>
          <Input
            id="account-current-password"
            name="currentPassword"
            type="password"
            value={form.values.currentPassword}
            onChange={(event) => form.set("currentPassword", event.target.value)}
            required
            maxLength={128}
            autoComplete="current-password"
            aria-invalid={wrong || undefined}
            aria-describedby={wrong ? "account-current-password-error" : undefined}
          />
          {wrong && (
            <FieldError id="account-current-password-error">{save.error?.message}</FieldError>
          )}
        </Field>
        <Field>
          <FieldLabel htmlFor="account-new-password">New password</FieldLabel>
          <Input
            id="account-new-password"
            name="password"
            type="password"
            value={form.values.password}
            onChange={(event) => {
              setDiffer(false);
              form.set("password", event.target.value);
            }}
            required
            minLength={MIN_PASSWORD_LENGTH}
            maxLength={128}
            autoComplete="new-password"
          />
        </Field>
        <Field data-invalid={differ || undefined}>
          <FieldLabel htmlFor="account-confirm-password">Confirm new password</FieldLabel>
          <Input
            id="account-confirm-password"
            name="confirmPassword"
            type="password"
            value={form.values.confirmPassword}
            onChange={(event) => {
              setDiffer(false);
              form.set("confirmPassword", event.target.value);
            }}
            required
            maxLength={128}
            autoComplete="new-password"
            aria-invalid={differ || undefined}
            aria-describedby={differ ? "account-confirm-password-error" : undefined}
          />
          {differ && (
            <FieldError id="account-confirm-password-error">{PASSWORDS_DIFFER}</FieldError>
          )}
        </Field>
        <Field orientation="horizontal">
          <Checkbox
            id="account-revoke-others"
            checked={form.values.revokeOtherSessions}
            onCheckedChange={(checked) => form.set("revokeOtherSessions", checked)}
          />
          <FieldLabel htmlFor="account-revoke-others" className="font-normal">
            Sign out of my other devices
          </FieldLabel>
        </Field>
        <Notice>{notice}</Notice>
      </FieldGroup>
    </SettingsSection>
  );
}

/** Asks before signing out one session, or all the others. */
function SignOutDialog({
  trigger,
  title,
  description,
  confirm,
  action,
  onDone,
}: {
  /** The button that opens it: its text, and its accessible name when the text is not enough. */
  trigger: { text: string; label?: string; size?: "sm" | "default" };
  title: string;
  description: string;
  confirm: string;
  action: () => Promise<void>;
  onDone: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const run = useMutation({
    mutationFn: action,
    onSuccess: () => {
      setOpen(false);
      onDone();
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) run.reset();
      }}
    >
      <Button
        variant="outline"
        size={trigger.size ?? "default"}
        aria-label={trigger.label}
        className="shrink-0"
        onClick={() => setOpen(true)}
      >
        {trigger.text}
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {run.error !== null && (
          <Alert variant="destructive" role="alert">
            <OctagonAlertIcon />
            <AlertDescription>{run.error.message}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
          <Button variant="destructive" onClick={() => run.mutate()} disabled={run.isPending}>
            {run.isPending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
            {confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SessionRow({
  session,
  current,
  timeZone,
  onSignedOut,
}: {
  session: AccountSession;
  current: boolean;
  timeZone: string | undefined;
  onSignedOut: (name: string) => void;
}) {
  const name = deviceName(session.userAgent);
  return (
    <li className="flex items-center gap-3 py-3">
      <MonitorSmartphoneIcon aria-hidden="true" className="size-4 shrink-0 text-ink-subtle" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <TruncatedText className="text-sm font-medium text-ink">{name}</TruncatedText>
          {current && (
            <Badge variant="outline" className="shrink-0">
              This device
            </Badge>
          )}
        </div>
        <p className="text-xs text-ink-subtle">
          Signed in {formatMoment(session.createdAt.toISOString(), timeZone)}.{" "}
          {current
            ? "Active now."
            : `Last active ${formatDay(session.updatedAt.toISOString(), timeZone)}.`}
        </p>
      </div>
      {!current && (
        <SignOutDialog
          trigger={{ text: "Sign out", label: `Sign out ${name}`, size: "sm" }}
          title={`Sign out ${name}?`}
          description="That browser is signed out at once, and needs your password to sign in again."
          confirm="Sign out"
          action={() => revokeSession(session.token)}
          onDone={() => onSignedOut(name)}
        />
      )}
    </li>
  );
}

function SessionsTab() {
  const queryClient = useQueryClient();
  const me = useQuery(meQuery());
  const sessions = useQuery(accountSessionsQuery());
  const [notice, setNotice] = React.useState("");
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  if (sessions.isPending) return <SectionSkeleton />;
  if (sessions.isError) {
    return (
      <SectionFailed
        title="Your sessions could not load"
        message={sessions.error.message}
        retry={() => void sessions.refetch()}
      />
    );
  }
  const { currentId } = sessions.data;
  const others = sessions.data.sessions.filter((item) => item.id !== currentId);
  const signedOut = async (message: string) => {
    setNotice(message);
    await queryClient.invalidateQueries({ queryKey: accountSessionsQuery().queryKey });
    // The button that had focus went with its row.
    headingRef.current?.focus();
  };
  return (
    <SettingsSection
      title="Sessions"
      headingRef={headingRef}
      description={
        <>
          <p>Every browser signed in to your account. Signing one out ends its session at once.</p>
          <p className="mt-1">
            Ottertrail doesn't record where a device signed in from, because it never stores IP
            addresses.
          </p>
        </>
      }
    >
      <ul aria-label="Your sessions" className="divide-y border-y">
        {sessions.data.sessions.map((item) => (
          <SessionRow
            key={item.id}
            session={item}
            current={item.id === currentId}
            timeZone={me.data?.instance.timeZone}
            onSignedOut={(name) => void signedOut(`${name} is signed out.`)}
          />
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        {others.length > 0 ? (
          <SignOutDialog
            trigger={{ text: "Sign out of all other devices" }}
            title="Sign out of all other devices?"
            description={`${others.length === 1 ? "1 other session ends" : `${others.length} other sessions end`} at once. This browser stays signed in.`}
            confirm="Sign out of other devices"
            action={revokeOtherSessions}
            onDone={() => void signedOut("Your other devices are signed out.")}
          />
        ) : (
          <p className="text-sm text-ink-subtle">No other device is signed in.</p>
        )}
        <Notice>{notice}</Notice>
      </div>
    </SettingsSection>
  );
}

/** The tab row and a section, while the session loads. */
function PageSkeleton() {
  return (
    <div className="flex flex-col" aria-busy="true" aria-label="Loading your account">
      <div className="flex h-10 items-center gap-6 border-b px-gutter">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-20" />
      </div>
      <div className="px-gutter">
        <SectionSkeleton />
      </div>
    </div>
  );
}

type DirtyPart = "name" | "email" | "password";

/**
 * /account: the signed-in user's own name, email, password, and sessions,
 * for every user (docs/dashboard.md, "Account settings").
 */
export function AccountPage() {
  const me = useQuery(meQuery());
  const [dirty, setDirty] = React.useState<Record<DirtyPart, boolean>>({
    name: false,
    email: false,
    password: false,
  });
  // One stable callback per form, so a form's effect does not run on every render.
  const mark = React.useMemo(() => {
    const of = (part: DirtyPart) => (next: boolean) =>
      setDirty((previous) => (previous[part] === next ? previous : { ...previous, [part]: next }));
    return { name: of("name"), email: of("email"), password: of("password") };
  }, []);

  if (me.isPending) return <PageSkeleton />;
  if (me.isError) {
    return (
      <div className="px-gutter">
        <SectionFailed
          title="Your account could not load"
          message={me.error.message}
          retry={() => void me.refetch()}
        />
      </div>
    );
  }
  const user = me.data.user;
  const tabs: SettingsTab[] = [
    {
      value: "profile",
      label: "Profile",
      // Two forms: either one's edits mark the tab.
      dirty: dirty.name || dirty.email,
      content: (
        <>
          <NameForm name={user.name} onDirty={mark.name} />
          <EmailForm email={user.email} onDirty={mark.email} />
        </>
      ),
    },
    {
      value: "password",
      label: "Password",
      dirty: dirty.password,
      content: <PasswordTab onDirty={mark.password} />,
    },
    { value: "sessions", label: "Sessions", content: <SessionsTab /> },
  ];
  return <SettingsTabs label="Account settings" tabs={tabs} />;
}
