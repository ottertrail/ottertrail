import { Link } from "@tanstack/react-router";
import { LoaderCircleIcon, MailCheckIcon, OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { formText } from "@/lib/form";
import { requestPasswordReset } from "@/lib/links-api";
import { fetchSetupStatus } from "@/lib/setup-api";

import { AuthLayout } from "./auth-layout";

/** Fallback response, identical for every address. */
const REQUESTED =
  "If an account uses that email, we'll send a reset link. Check your inbox and spam folder.";
/** Both rate limits use this response without a wait time. */
const LIMITED = "Too many reset requests. Wait a little, then try again.";
const NO_EMAIL =
  "Email isn't set up on this instance. Ask the person who runs it for a reset link.";

const backToSignIn = (
  <Link
    to="/sign-in"
    className="self-start rounded-sm text-sm text-link underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
  >
    Back to sign in
  </Link>
);

/** Use the same response for every address to avoid revealing accounts. */
export function ForgotPasswordPage() {
  const [emailConfigured, setEmailConfigured] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    const controller = new AbortController();
    fetchSetupStatus(controller.signal).then(
      (status) => setEmailConfigured(status.emailConfigured),
      () => {
        // If setup status fails, let the API report missing email configuration.
        if (!controller.signal.aborted) setEmailConfigured(true);
      },
    );
    return () => controller.abort();
  }, []);
  const [answer, setAnswer] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = formText(new FormData(event.currentTarget), "email").trim();
    setPending(true);
    setError(null);
    try {
      const result = await requestPasswordReset(email);
      setAnswer(result.message || REQUESTED);
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 429
          ? LIMITED
          : failure instanceof Error
            ? failure.message
            : "The request could not be sent. Try again.",
      );
    } finally {
      setPending(false);
    }
  }

  const title = "Reset your password";

  if (emailConfigured === null) {
    return (
      <AuthLayout title={title}>
        <div className="flex flex-col gap-3" aria-busy="true">
          <span className="sr-only">Loading…</span>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      </AuthLayout>
    );
  }
  if (!emailConfigured) {
    return (
      <AuthLayout title={title}>
        <Alert>
          <OctagonAlertIcon />
          <AlertDescription>{NO_EMAIL}</AlertDescription>
        </Alert>
        {backToSignIn}
      </AuthLayout>
    );
  }
  if (answer !== null) {
    return (
      <AuthLayout title={title}>
        <output className="block">
          <Alert role="none">
            <MailCheckIcon />
            <AlertDescription>{answer}</AlertDescription>
          </Alert>
        </output>
        {backToSignIn}
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title={title}>
      <form onSubmit={(event) => void submit(event)}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              maxLength={320}
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
            Send reset link
          </Button>
        </FieldGroup>
      </form>
      {backToSignIn}
    </AuthLayout>
  );
}
