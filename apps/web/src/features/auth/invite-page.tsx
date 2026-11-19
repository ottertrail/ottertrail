import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LoaderCircleIcon, OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { authClient, signInErrorMessage } from "@/lib/auth-client";
import { formText } from "@/lib/form";
import { acceptInvitation, previewInvitation } from "@/lib/links-api";

import { AuthLayout } from "./auth-layout";
import { MIN_PASSWORD_LENGTH, useLinkToken } from "./link-token";

/** Every link that no longer works gets this, whatever the reason (docs/access.md). */
export const LINK_GONE = "This invitation link no longer works. Ask for a new one.";

/**
 * Accepting an invitation (/invite#token=…). The page shows who invited
 * whom, and to which instance; not the role or access. Accept reveals the name and
 * password fields; nothing is saved until they are submitted, so closing
 * the page leaves the invitation pending. A signed-in visitor signs out first.
 */
export function InvitePage() {
  const navigate = useNavigate();
  const token = useLinkToken();
  // Asked afresh each time the page opens: a session cached since may have ended.
  const session = useQuery({
    queryKey: ["link-page-session"],
    queryFn: async () => (await authClient.getSession()).data,
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
  const preview = useQuery({
    // The token stays out of the key, which tools and caches may show; the
    // answer is not kept once the page is gone.
    queryKey: ["invitation-preview"],
    queryFn: ({ signal }) => previewInvitation(token ?? "", signal),
    enabled: token !== null,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  const [accepting, setAccepting] = React.useState(false);
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
      const { email } = await acceptInvitation({
        token,
        name: formText(form, "name"),
        password,
        confirmPassword: password,
      });
      const signedIn = await authClient.signIn.email({ email, password });
      if (signedIn.error) {
        setPending(false);
        setError(
          `Your account was created, but signing in failed: ${signInErrorMessage(signedIn.error)}`,
        );
        return;
      }
      await navigate({ to: "/" });
    } catch (failure) {
      setPending(false);
      setError(
        failure instanceof Error ? failure.message : "The invitation could not be accepted.",
      );
    }
  }

  if (token === null || preview.isError) {
    const gone =
      token === null || (preview.error instanceof ApiError && preview.error.status === 404);
    return (
      <AuthLayout title="Invitation" description="Join an Ottertrail instance.">
        <Alert variant={gone ? "default" : "destructive"}>
          <OctagonAlertIcon />
          <AlertDescription>{gone ? LINK_GONE : preview.error?.message}</AlertDescription>
        </Alert>
      </AuthLayout>
    );
  }
  if (preview.data === undefined || session.isPending) {
    return (
      <AuthLayout title="Invitation" description="Join an Ottertrail instance.">
        <p className="text-sm text-ink-subtle" aria-busy="true">
          Loading the invitation…
        </p>
      </AuthLayout>
    );
  }
  const invitation = preview.data;
  return (
    <AuthLayout
      title={`Join ${invitation.instanceName}`}
      description={`${invitation.invitedBy} invited ${invitation.email} to ${invitation.instanceName} on Ottertrail.`}
    >
      <div className="flex flex-col gap-5">
        {session.data != null ? (
          <Alert>
            <OctagonAlertIcon />
            <AlertTitle>You are signed in as {session.data.user.email}</AlertTitle>
            <AlertDescription>
              <p>Sign out first to accept this invitation.</p>
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
        ) : !accepting ? (
          <Button onClick={() => setAccepting(true)}>Accept</Button>
        ) : (
          <form onSubmit={(event) => void submit(event)}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="invite-email">Email</FieldLabel>
                <Input id="invite-email" value={invitation.email} readOnly disabled />
              </Field>
              <Field>
                <FieldLabel htmlFor="name">Name</FieldLabel>
                <Input id="name" name="name" autoComplete="name" required maxLength={200} />
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
        )}
      </div>
    </AuthLayout>
  );
}
