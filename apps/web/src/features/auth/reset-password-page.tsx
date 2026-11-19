import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LoaderCircleIcon, OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { authClient, signInErrorMessage } from "@/lib/auth-client";
import { formText } from "@/lib/form";
import { previewReset, resetPassword } from "@/lib/links-api";

import { AuthLayout } from "./auth-layout";
import { MIN_PASSWORD_LENGTH, useLinkToken } from "./link-token";

const LINK_GONE = "This reset link no longer works. Ask for a new one.";

/**
 * Setting a password from a reset link (/reset-password#token=…). Using it
 * signs the account out everywhere, then signs it in here; the old password
 * works until then.
 */
export function ResetPasswordPage() {
  const navigate = useNavigate();
  const token = useLinkToken();
  const preview = useQuery({
    // The token stays out of the key; the answer is not kept once the page is gone.
    queryKey: ["reset-link-preview"],
    queryFn: ({ signal }) => previewReset(token ?? "", signal),
    enabled: token !== null,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  // Asked afresh each time the page opens: a session cached since may have ended.
  const session = useQuery({
    queryKey: ["link-page-session"],
    queryFn: async () => (await authClient.getSession()).data,
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (token === null) return;
    const form = new FormData(event.currentTarget);
    const password = formText(form, "password");
    if (password !== formText(form, "confirm-password")) {
      setError("The passwords do not match. Enter the same password in both fields.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const { email } = await resetPassword({ token, password, confirmPassword: password });
      const signedIn = await authClient.signIn.email({ email, password });
      if (signedIn.error) {
        setPending(false);
        setError(
          `Your password was set, but signing in failed: ${signInErrorMessage(signedIn.error)}`,
        );
        return;
      }
      await navigate({ to: "/" });
    } catch (failure) {
      setPending(false);
      setError(failure instanceof Error ? failure.message : "The password could not be set.");
    }
  }

  if (token === null || preview.isError) {
    const gone =
      token === null || (preview.error instanceof ApiError && preview.error.status === 404);
    return (
      <AuthLayout title="Set a new password" description="A reset link sets it.">
        <Alert variant={gone ? "default" : "destructive"}>
          <OctagonAlertIcon />
          <AlertDescription>{gone ? LINK_GONE : preview.error?.message}</AlertDescription>
        </Alert>
      </AuthLayout>
    );
  }
  if (preview.data === undefined || session.isPending) {
    return (
      <AuthLayout title="Set a new password" description="A reset link sets it.">
        <div className="flex flex-col gap-3" aria-busy="true">
          <span className="sr-only">Loading…</span>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      </AuthLayout>
    );
  }
  if (session.data != null) {
    return (
      <AuthLayout title="Set a new password" description={`For ${preview.data.email}.`}>
        <Alert>
          <OctagonAlertIcon />
          <AlertTitle>You are signed in as {session.data.user.email}</AlertTitle>
          <AlertDescription>
            <p>Sign out first to use this reset link.</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void authClient.signOut().then(() => session.refetch())}
            >
              Sign out
            </Button>
          </AlertDescription>
        </Alert>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout
      title="Set a new password"
      description={`For ${preview.data.email}. Every device signed in to this account is signed out.`}
    >
      <form onSubmit={(event) => void submit(event)}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="password">New password</FieldLabel>
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
            Set password
          </Button>
        </FieldGroup>
      </form>
    </AuthLayout>
  );
}
