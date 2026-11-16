import { Link, useNavigate } from "@tanstack/react-router";
import { LoaderCircleIcon, OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient, signInErrorMessage } from "@/lib/auth-client";
import { formText } from "@/lib/form";
import { createOwner } from "@/lib/setup-api";

import { AuthLayout } from "./auth-layout";

/** Matches the API's minimum (MIN_PASSWORD_LENGTH in apps/api/src/auth/auth.ts). */
const MIN_PASSWORD_LENGTH = 12;

/**
 * Reads the setup token from the link's fragment (#token=…) once, then
 * removes it from the address bar, so it does not stay on screen or in the
 * browser's history.
 */
function useSetupToken(): string | null {
  const [token] = React.useState(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get("token");
    return value === null || value === "" ? null : value;
  });
  React.useEffect(() => {
    if (window.location.hash !== "") {
      window.history.replaceState(window.history.state, "", window.location.pathname);
    }
  }, []);
  return token;
}

export function SetupPage() {
  const navigate = useNavigate();
  const token = useSetupToken();
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
    setPending(true);
    setError(null);
    const created = await createOwner({ token, name: formText(form, "name"), email, password });
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
            On the server, run <code className="font-mono">vp run setup</code> and open the link it
            prints. If the owner account already exists, <Link to="/sign-in">sign in</Link> instead.
          </AlertDescription>
        </Alert>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Create the owner account"
      description="The owner manages this instance. You can invite teammates later."
    >
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
