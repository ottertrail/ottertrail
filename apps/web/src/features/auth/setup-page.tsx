import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { LoaderCircleIcon, OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { TimezoneCombobox } from "@/components/timezone-combobox";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient, signInErrorMessage } from "@/lib/auth-client";
import { formText } from "@/lib/form";
import { createOwner, fetchSetupStatus } from "@/lib/setup-api";

import { AuthLayout } from "./auth-layout";
import { MIN_PASSWORD_LENGTH, useLinkToken } from "./link-token";

/** The browser's own timezone, chosen until another is picked. */
const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function SetupPage() {
  const navigate = useNavigate();
  const token = useLinkToken();
  const status = useQuery({
    queryKey: ["setup"],
    queryFn: ({ signal }) => fetchSetupStatus(signal),
  });
  const [timeZone, setTimeZone] = React.useState(browserTimeZone);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  async function createAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (token === null) {
      return;
    }
    const form = new FormData(event.currentTarget);
    const email = formText(form, "email");
    const password = formText(form, "password");
    if (password !== formText(form, "confirm-password")) {
      setError("The two passwords differ. Type the same password twice.");
      return;
    }
    setPending(true);
    setError(null);
    const created = await createOwner({
      token,
      name: formText(form, "name"),
      email,
      password,
      confirmPassword: password,
      instanceName: formText(form, "workspace"),
      timeZone: timeZone.trim(),
    });
    if (!created.ok) {
      setPending(false);
      setError(created.message);
      return;
    }
    const signedIn = await authClient.signIn.email({ email, password });
    setPending(false);
    if (signedIn.error) {
      setError(
        `Your account was created, but signing in failed: ${signInErrorMessage(signedIn.error)}`,
      );
      return;
    }
    await navigate({ to: "/" });
  }

  if (token === null) {
    return (
      <AuthLayout title="Set up Ottertrail" description="This page needs a setup link.">
        <Alert>
          <OctagonAlertIcon />
          <AlertTitle>No setup link</AlertTitle>
          <AlertDescription>
            On the server, in the instance&apos;s folder, run{" "}
            <code className="font-mono">docker compose exec api node dist/setup.mjs</code> and open
            the link it prints (in development: <code className="font-mono">vp run setup</code>). If
            the owner account already exists, <Link to="/sign-in">sign in</Link> instead.
          </AlertDescription>
        </Alert>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Create the owner account" description="The owner manages this install.">
      <form onSubmit={(event) => void createAccount(event)}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input id="name" name="name" autoComplete="name" required maxLength={200} />
          </Field>
          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </Field>
          <Field>
            <FieldLabel htmlFor="workspace">Workspace name</FieldLabel>
            <Input
              id="workspace"
              name="workspace"
              autoComplete="organization"
              required
              maxLength={100}
              aria-describedby="workspace-hint"
            />
            <FieldDescription id="workspace-hint">
              Shown at the top of the sidebar, such as your company&apos;s or team&apos;s name. You
              can change it later in Settings.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              maxLength={128}
              aria-describedby="password-hint"
            />
            <FieldDescription id="password-hint">
              At least {MIN_PASSWORD_LENGTH} characters. A passphrase of a few words works well.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="confirm-password">Confirm password</FieldLabel>
            <Input
              id="confirm-password"
              name="confirm-password"
              type="password"
              autoComplete="new-password"
              required
              maxLength={128}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="time-zone">Timezone</FieldLabel>
            <TimezoneCombobox
              id="time-zone"
              name="time-zone"
              value={timeZone}
              onValueChange={setTimeZone}
              required
              aria-describedby="time-zone-hint"
            />
            <FieldDescription id="time-zone-hint">
              Reports count days in it. Your browser&apos;s is chosen; the owner can change it later
              in Settings.
            </FieldDescription>
          </Field>
          {status.data !== undefined && (
            <p className="text-sm text-ink-muted" aria-label="Alert email">
              {status.data.emailConfigured ? (
                "Email for alerts is set up on this server."
              ) : (
                <>
                  Email for alerts is not set up. Alerts can still go to webhooks; to send email,
                  set <code className="font-mono">SMTP_URL</code> and{" "}
                  <code className="font-mono">EMAIL_FROM</code> on the server and restart it.
                </>
              )}
            </p>
          )}
          {error !== null && (
            <Alert variant="destructive" role="alert">
              <OctagonAlertIcon />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" disabled={pending}>
            {pending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
            Create account
          </Button>
        </FieldGroup>
      </form>
    </AuthLayout>
  );
}
