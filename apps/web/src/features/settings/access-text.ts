import { AREA_LABELS, AREAS, type Preset, PRESETS, presetOf } from "@/lib/access";
import type { MemberAccess } from "@/lib/members-api";

export const PRESET_LABEL: Record<Preset, { name: string; about: string }> = {
  viewer: { name: "Viewer", about: "View everything except replays and users." },
  engineering: {
    name: "Engineering",
    about: "Manage errors, uptime, and alerts. View monitoring, replays, and both analytics areas.",
  },
  marketing: {
    name: "Marketing",
    about: "View web analytics. Manage product analytics. No access to other areas.",
  },
  custom: { name: "Custom", about: "Choose each area below." },
};

/** A new member's access before anything is chosen: the Viewer preset, on every project. */
export const DEFAULT_ACCESS: MemberAccess = { projects: "all", areas: { ...PRESETS.viewer } };

/**
 * A member's access in a few words: the preset's name, or with a custom set
 * the areas they have, then where. "Viewer · All projects",
 * "Web analytics, Errors · 2 projects".
 */
export function accessSummary(access: MemberAccess): string {
  const preset = presetOf(access.areas);
  const areas = AREAS.filter((area) => access.areas[area] !== "none").map(
    (area) => AREA_LABELS[area].name,
  );
  const what =
    preset !== "custom"
      ? PRESET_LABEL[preset].name
      : areas.length === 0
        ? "No areas"
        : areas.join(", ");
  const { projects } = access;
  const where =
    projects === "all"
      ? "All projects"
      : projects.length === 1
        ? "1 project"
        : `${projects.length} projects`;
  return `${what} · ${where}`;
}

/** Why a link can't be shown twice, and what to do when it is lost. */
export const LINK_ONCE =
  "Only a fingerprint is saved, so this link can't be shown again. Copy it now.";

/** What to say beside an emailed link: what to do if the email goes missing. */
export const emailedAbout = (who: string) =>
  `If it doesn't arrive in a few minutes, ask ${who} to check spam or send them the link yourself. ${LINK_ONCE}`;
