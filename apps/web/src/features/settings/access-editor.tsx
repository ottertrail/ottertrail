import * as React from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { FieldDescription, FieldLegend, FieldSet } from "@/components/ui/field";
import {
  AREA_LABELS,
  AREA_LEVELS,
  type AreaLevel,
  AREAS,
  PRESET_NAMES,
  PRESETS,
  presetOf,
} from "@/lib/access";
import type { AccessChoice, MemberAccess } from "@/lib/members-api";
import type { ProjectSummary } from "@/lib/projects-api";

import { DEFAULT_ACCESS, PRESET_LABEL } from "./access-text";

const LEVEL_LABEL: Record<AreaLevel, string> = { none: "None", view: "View", manage: "Manage" };

/** A native radio with its label, as a row. */
function Radio({
  name,
  value,
  checked,
  onChange,
  children,
  description,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  children: React.ReactNode;
  description?: string;
}) {
  const id = React.useId();
  return (
    <div className="flex items-start gap-2">
      <input
        type="radio"
        id={id}
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        className="mt-0.5 size-4 accent-primary"
      />
      <label htmlFor={id} className="text-sm text-ink">
        {children}
        {description !== undefined && (
          <span className="block text-xs text-ink-subtle">{description}</span>
        )}
      </label>
    </div>
  );
}

/**
 * The role, and for a member a preset, each area's level, and the projects
 * (docs/access.md). An admin choice shows only when `allowAdmin`, for the
 * owner. Changing an area makes the preset Custom.
 */
export function AccessEditor({
  value,
  onChange,
  allowAdmin,
  projects,
}: {
  value: AccessChoice;
  onChange: (next: AccessChoice) => void;
  allowAdmin: boolean;
  projects: readonly ProjectSummary[];
}) {
  const name = React.useId();
  // What a member had, kept while Admin is chosen, so switching back loses nothing.
  const [memberAccess, setMemberAccess] = React.useState<MemberAccess>(
    value.role === "member" ? value.access : DEFAULT_ACCESS,
  );
  const setAccess = (access: MemberAccess) => {
    setMemberAccess(access);
    onChange({ role: "member", access });
  };
  const access = value.role === "member" ? value.access : memberAccess;
  const preset = presetOf(access.areas);
  const chosen = access.projects === "all" ? [] : access.projects;

  return (
    <div className="flex flex-col gap-5">
      {allowAdmin && (
        <FieldSet>
          <FieldLegend variant="label">Role</FieldLegend>
          <Radio
            name={`${name}-role`}
            value="admin"
            checked={value.role === "admin"}
            onChange={() => onChange({ role: "admin" })}
            description="Access to every project and area, project keys and settings, channels, and members. No access to instance settings or ownership."
          >
            Admin
          </Radio>
          <Radio
            name={`${name}-role`}
            value="member"
            checked={value.role === "member"}
            onChange={() => onChange({ role: "member", access: memberAccess })}
            description="Only the areas and projects chosen below."
          >
            Member
          </Radio>
        </FieldSet>
      )}
      {value.role === "member" && (
        <>
          <FieldSet>
            <FieldLegend variant="label">Preset</FieldLegend>
            {[...PRESET_NAMES, "custom" as const].map((item) => (
              <Radio
                key={item}
                name={`${name}-preset`}
                value={item}
                checked={preset === item}
                onChange={() => {
                  if (item !== "custom") setAccess({ ...access, areas: { ...PRESETS[item] } });
                }}
                description={PRESET_LABEL[item].about}
              >
                {PRESET_LABEL[item].name}
              </Radio>
            ))}
          </FieldSet>
          <FieldSet>
            <FieldLegend variant="label">Areas</FieldLegend>
            <FieldDescription>
              Replays and users show individual people. Each has a separate access area.
            </FieldDescription>
            <div className="flex flex-col gap-3">
              {AREAS.map((area) => (
                <fieldset key={area} className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <legend className="float-left w-full text-sm font-medium text-ink sm:w-56">
                    {AREA_LABELS[area].name}
                    <span className="block text-xs font-normal text-ink-subtle">
                      {AREA_LABELS[area].pages}
                    </span>
                  </legend>
                  {AREA_LEVELS[area].map((level) => (
                    <Radio
                      key={level}
                      name={`${name}-${area}`}
                      value={level}
                      checked={access.areas[area] === level}
                      onChange={() =>
                        setAccess({ ...access, areas: { ...access.areas, [area]: level } })
                      }
                    >
                      {LEVEL_LABEL[level]}
                      <span className="sr-only"> {AREA_LABELS[area].name}</span>
                    </Radio>
                  ))}
                </fieldset>
              ))}
            </div>
          </FieldSet>
          <FieldSet>
            <FieldLegend variant="label">Projects</FieldLegend>
            <Radio
              name={`${name}-projects`}
              value="all"
              checked={access.projects === "all"}
              onChange={() => setAccess({ ...access, projects: "all" })}
            >
              All projects, including new ones
            </Radio>
            <Radio
              name={`${name}-projects`}
              value="chosen"
              checked={access.projects !== "all"}
              onChange={() => setAccess({ ...access, projects: [...chosen] })}
            >
              Chosen projects
            </Radio>
            {access.projects !== "all" && (
              <div className="flex flex-col gap-2 pl-6">
                {projects.length === 0 && (
                  <p className="text-sm text-ink-subtle">The instance has no projects yet.</p>
                )}
                {projects.map((project) => {
                  const id = `${name}-project-${project.id}`;
                  return (
                    <div key={project.id} className="flex items-center gap-2">
                      <Checkbox
                        id={id}
                        checked={chosen.includes(project.id)}
                        onCheckedChange={(next) =>
                          setAccess({
                            ...access,
                            projects: next
                              ? [...chosen, project.id]
                              : chosen.filter((item) => item !== project.id),
                          })
                        }
                      />
                      <label htmlFor={id} className="text-sm text-ink">
                        {project.name}
                      </label>
                    </div>
                  );
                })}
              </div>
            )}
          </FieldSet>
        </>
      )}
    </div>
  );
}
