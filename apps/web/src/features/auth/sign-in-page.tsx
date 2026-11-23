import { Link, useNavigate } from "@tanstack/react-router";
import { InfoIcon, LoaderCircleIcon, OctagonAlertIcon } from "lucide-react";
import * as React from "react";

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
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient, signInErrorMessage } from "@/lib/auth-client";
import { formText } from "@/lib/form";
import { fetchSetupStatus } from "@/lib/setup-api";

import { AuthLayout } from "./auth-layout";

/** Return null while setup status is unknown or failed. */
function useSetupStatus(): { ownerExists: boolean; emailConfigured: boolean } | null {
  const [status, setStatus] = React.useState<{
    ownerExists: boolean;
    emailConfigured: boolean;
  } | null>(null);
  React.useEffect(() => {
    const controller = new AbortController();
    fetchSetupStatus(controller.signal).then(setStatus, () => {
      // A failed setup check must not block sign-in.
    });
    return () => controller.abort();
  }, []);
  return status;
}

export function SignInPage() {
  const navigate = useNavigate();
  const status = useSetupStatus();
  const ownerExists = status?.ownerExists ?? null;
  const emailConfigured = status?.emailConfigured ?? null;
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
    <AuthLayout title="Sign in">
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
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <FieldLabel htmlFor="password">Password</FieldLabel>
              {emailConfigured === false ? (
                <Dialog>
                  <DialogTrigger className="relative rounded-sm text-sm text-link underline-offset-4 outline-none after:absolute after:-inset-x-1 after:-inset-y-2.5 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">
                    Forgot password?
                  </DialogTrigger>
                  <DialogContent showCloseButton={false}>
                    <DialogHeader>
                      <DialogTitle>Forgot your password?</DialogTitle>
                      <DialogDescription>
                        Email isn't set up on this instance. Ask the person who runs it for a reset
                        link.
                      </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                      <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              ) : (
                <Link
                  to="/forgot-password"
                  className="relative rounded-sm text-sm text-link underline-offset-4 outline-none after:absolute after:-inset-x-1 after:-inset-y-2.5 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  Forgot password?
                </Link>
              )}
            </div>
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
