import { useNavigate } from "@tanstack/react-router";
import { InfoIcon, LoaderCircleIcon, OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient, signInErrorMessage } from "@/lib/auth-client";
import { formText } from "@/lib/form";
import { fetchOwnerExists } from "@/lib/setup-api";

import { AuthLayout } from "./auth-layout";

/** Whether the instance has its owner yet; null while unknown or when the check failed. */
function useOwnerExists(): boolean | null {
  const [ownerExists, setOwnerExists] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    const controller = new AbortController();
    fetchOwnerExists(controller.signal).then(setOwnerExists, () => {
      // The sign-in form still works; the hint about setup is only extra.
    });
    return () => controller.abort();
  }, []);
  return ownerExists;
}

export function SignInPage() {
  const navigate = useNavigate();
  const ownerExists = useOwnerExists();
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const result = await authClient.signIn.email({
      email: formText(form, "email"),
      password: formText(form, "password"),
    });
    setPending(false);
    if (result.error) {
      setError(signInErrorMessage(result.error));
      return;
    }
    await navigate({ to: "/" });
  }

  return (
    <AuthLayout title="Sign in" description="Sign in to this Ottertrail instance.">
      {ownerExists === false && (
        <Alert>
          <InfoIcon />
          <AlertTitle>No account exists yet</AlertTitle>
          <AlertDescription>
            On the server, in the instance&apos;s folder, run{" "}
            <code className="font-mono">docker compose exec api node dist/setup.mjs</code> and open
            the link it prints to create the owner account. In development, run{" "}
            <code className="font-mono">vp run setup</code> instead.
          </AlertDescription>
        </Alert>
      )}
      <form onSubmit={(event) => void signIn(event)}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input id="email" name="email" type="email" autoComplete="username" required />
          </Field>
          <Field>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </Field>
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
            Sign in
          </Button>
        </FieldGroup>
      </form>
    </AuthLayout>
  );
}
