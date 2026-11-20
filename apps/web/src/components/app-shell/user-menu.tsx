import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronsUpDownIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
  UserCogIcon,
} from "lucide-react";

import { OverflowTooltip, TruncatedText } from "@/components/truncated-text";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
import { UserAvatar } from "@/components/user-avatar";
import { meQuery } from "@/lib/access";
import { authClient } from "@/lib/auth-client";
import {
  isThemeChoice,
  setThemeChoice,
  THEME_CHOICES,
  type ThemeChoice,
  useTheme,
} from "@/lib/theme";

const THEME_ITEMS: Record<ThemeChoice, { label: string; icon: typeof SunIcon }> = {
  system: { label: "System", icon: MonitorIcon },
  light: { label: "Light", icon: SunIcon },
  dark: { label: "Dark", icon: MoonIcon },
};

/** The theme, as on the Account settings page's Appearance tab: applied at once, kept on this device. */
function ThemeItems() {
  const { choice } = useTheme();
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel className="px-1.5 text-xs font-normal text-ink-subtle">
        Theme
      </DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={choice}
        onValueChange={(value: unknown) => {
          if (isThemeChoice(value)) setThemeChoice(value);
        }}
      >
        {THEME_CHOICES.map((value) => {
          const { label, icon: Icon } = THEME_ITEMS[value];
          return (
            <DropdownMenuRadioItem key={value} value={value}>
              <Icon aria-hidden="true" />
              {label}
            </DropdownMenuRadioItem>
          );
        })}
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  );
}

/**
 * The sidebar's foot: who is signed in, as shadcn's NavUser block. It opens
 * a menu with the account's settings, the theme, and Sign out. Collapsed to icons, only
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
  const { name, email, avatarUrl } = me.user;
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
            <UserAvatar name={name} email={email} src={avatarUrl} />
            <span className="grid min-w-0 flex-1 text-left leading-tight">
              <TruncatedText text={name} className="text-sm font-medium text-ink" />
              <TruncatedText text={email} className="text-xs text-ink-subtle" />
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
                <UserAvatar name={name} email={email} src={avatarUrl} />
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
            <ThemeItems />
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
