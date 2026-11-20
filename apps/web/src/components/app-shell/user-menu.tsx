import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronsUpDownIcon, LogOutIcon, UserCogIcon } from "lucide-react";

import { OverflowTooltip, TruncatedText } from "@/components/truncated-text";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { meQuery } from "@/lib/access";
import { authClient } from "@/lib/auth-client";

/** The first character a reader sees: a whole emoji or accented letter, not half of one. */
const firstCharacter = (text: string) =>
  new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)[Symbol.iterator]().next()
    .value?.segment ?? "";

/** "Ada Lovelace" is AL, "Ada" is A; with no name, the email's first letter. */
function initialsOf(name: string, email: string): string {
  const words = name
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== "");
  const first = words[0];
  if (first === undefined) return firstCharacter(email).toLocaleUpperCase();
  const last = words.length > 1 ? words.at(-1) : undefined;
  return `${firstCharacter(first)}${last === undefined ? "" : firstCharacter(last)}`.toLocaleUpperCase();
}

/** There are no photos: the initials stand in, on the sidebar's accent. */
function UserAvatar({ name, email }: { name: string; email: string }) {
  return (
    <Avatar className="size-8 rounded-md after:rounded-md" aria-hidden="true">
      <AvatarFallback className="rounded-md bg-sidebar-accent text-xs font-semibold text-ink">
        {initialsOf(name, email)}
      </AvatarFallback>
    </Avatar>
  );
}

/**
 * The sidebar's foot: who is signed in, as shadcn's NavUser block. It opens
 * a menu with the account's settings and Sign out. Collapsed to icons, only
 * the avatar shows, and its tooltip names the user.
 */
export function UserMenu() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isMobile, state } = useSidebar();
  // The user as GET /api/me has them: read again when the account changes.
  const me = useQuery(meQuery()).data;
  if (me === undefined) {
    return <Skeleton className="h-12 w-full group-data-[collapsible=icon]:size-8" />;
  }
  const { name, email } = me.user;
  const collapsed = state === "collapsed" && !isMobile;

  async function signOut() {
    await authClient.signOut();
    // The next person to sign in here may be another user of this instance:
    // nothing of this one's may show for them, not even while refetching.
    queryClient.clear();
    await navigate({ to: "/sign-in" });
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <OverflowTooltip
            always={collapsed}
            side={collapsed ? "right" : "top"}
            content={
              <>
                <span className="font-medium">{name}</span>
                <span>{email}</span>
              </>
            }
            render={
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton
                    size="lg"
                    className="data-popup-open:bg-sidebar-accent"
                    aria-label={`${name}, ${email}. Account menu`}
                  />
                }
              />
            }
          >
            <UserAvatar name={name} email={email} />
            <span className="grid min-w-0 flex-1 text-left leading-tight">
              <TruncatedText focusable={false} className="text-sm font-medium text-ink">
                {name}
              </TruncatedText>
              <TruncatedText focusable={false} className="text-xs text-ink-subtle">
                {email}
              </TruncatedText>
            </span>
            <ChevronsUpDownIcon aria-hidden="true" className="ml-auto text-ink-subtle" />
          </OverflowTooltip>
          <DropdownMenuContent
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
            className="w-auto max-w-[min(20rem,calc(100vw-2rem))] min-w-56"
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="flex items-center gap-2 px-1 py-1.5 font-normal">
                <UserAvatar name={name} email={email} />
                {/* The menu wraps the name and email rather than cutting them off. */}
                <span className="grid min-w-0 flex-1 text-left leading-tight [overflow-wrap:anywhere]">
                  <span className="text-sm font-medium text-ink">{name}</span>
                  <span className="text-xs text-ink-subtle">{email}</span>
                </span>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void navigate({ to: "/account" })}>
              <UserCogIcon aria-hidden="true" />
              Account settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void signOut()}>
              <LogOutIcon aria-hidden="true" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
