import { type Preset, PRESETS, presetOf } from "@/lib/access";
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

/** "Viewer, all projects", "Custom, 2 projects": a member's access in a few words. */
export function accessSummary(access: MemberAccess): string {
  const preset = PRESET_LABEL[presetOf(access.areas)].name;
  const { projects } = access;
  const where =
    projects === "all"
      ? "all projects"
      : projects.length === 1
        ? "1 project"
        : `${projects.length} projects`;
  return `${preset}, ${where}`;
}
