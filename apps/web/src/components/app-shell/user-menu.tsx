import { useNavigate } from "@tanstack/react-router";
import { LogOutIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { authClient } from "@/lib/auth-client";

/** Who is signed in, with a sign-out button. */
export function UserMenu() {
  const navigate = useNavigate();
  const { data } = authClient.useSession();
  if (!data) {
    return null;
  }

  async function signOut() {
    await authClient.signOut();
    await navigate({ to: "/sign-in" });
  }

  return (
    <div className="flex items-center gap-2 px-1.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink">{data.user.name}</p>
        <p className="truncate text-xs text-ink-subtle">{data.user.email}</p>
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void signOut()}
              aria-label="Sign out"
            />
          }
        >
          <LogOutIcon />
        </TooltipTrigger>
        <TooltipContent>Sign out</TooltipContent>
      </Tooltip>
    </div>
  );
}
