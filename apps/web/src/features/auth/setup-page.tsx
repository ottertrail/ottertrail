import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { LoaderCircleIcon, MailCheckIcon, MailXIcon, OctagonAlertIcon } from "lucide-react";
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
      setError("The passwords do not match. Enter the same password in both fields.");
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
      <AuthLayout title="Set up Ottertrail">
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
    <AuthLayout title="Create the owner account">
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
            <FieldLabel htmlFor="workspace">Instance name</FieldLabel>
            <Input
              id="workspace"
              name="workspace"
              autoComplete="organization"
              required
              maxLength={100}
            />
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
              At least {MIN_PASSWORD_LENGTH} characters.
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
              Reports use this timezone for day boundaries.
            </FieldDescription>
          </Field>
          {status.data !== undefined && (
            <p
              className="flex items-start gap-2 border-t pt-4 text-sm text-ink-muted"
              aria-label="Email status"
            >
              {status.data.emailConfigured ? (
                <MailCheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
              ) : (
                <MailXIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              )}
              <span>
                {status.data.emailConfigured ? (
                  "Email is set up on this server: alerts, invitations, and password resets can be emailed."
                ) : (
                  <>
                    Email isn't set up on this server, so alerts go only to webhooks, and invitation
                    and reset links are copied and sent by hand. To send email, set{" "}
                    <code className="font-mono">SMTP_URL</code> and{" "}
                    <code className="font-mono">EMAIL_FROM</code> on the server and restart it.
                  </>
                )}
              </span>
            </p>
          )}
          {error !== null && (
            <Alert variant="destructive" role="alert">
              <OctagonAlertIcon />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" disabled={pending}>
            {pending && (
              <LoaderCircleIcon
                aria-hidden="true"
                className="animate-spin motion-reduce:animate-none"
              />
            )}
            Create account
          </Button>
        </FieldGroup>
      </form>
    </AuthLayout>
  );
}
