import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircleIcon, OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { Label } from "@/components/ui/label";
import { UserAvatar } from "@/components/user-avatar";
import { meQuery, useAccess } from "@/lib/access";
import {
  type Assignee,
  type ErrorGroup,
  errorAssigneesQuery,
  setErrorAssignee,
} from "@/lib/errors-api";

interface Option {
  id: string | null;
  name: string;
  avatarUrl: string | null;
}

const NOBODY: Option = { id: null, name: "Unassigned", avatarUrl: null };

export function AssigneeMark({ assignee }: { assignee: Assignee }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <UserAvatar name={assignee.name} src={assignee.avatarUrl} size="sm" className="size-5" />
      <span className="sr-only">Assigned to </span>
      <span className="truncate">{assignee.name}</span>
    </span>
  );
}

/** Assignment requires errors manage access (docs/errors.md, "Assignment"). */
export function AssigneeControl({ projectId, group }: { projectId: string; group: ErrorGroup }) {
  const canChange = useAccess().canUse("errors", "manage");
  const fieldId = React.useId();
  if (!canChange) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <span className="text-ink-subtle">Assignee</span>
        {group.assignee === null ? (
          <span className="text-ink-muted">Unassigned</span>
        ) : (
          <span className="flex items-center gap-1.5 text-ink">
            <UserAvatar name={group.assignee.name} src={group.assignee.avatarUrl} size="sm" />
            <span>{group.assignee.name}</span>
          </span>
        )}
      </div>
    );
  }
  return <AssigneeField projectId={projectId} group={group} fieldId={fieldId} />;
}

function AssigneeField({
  projectId,
  group,
  fieldId,
}: {
  projectId: string;
  group: ErrorGroup;
  fieldId: string;
}) {
  const queryClient = useQueryClient();
  const me = useQuery(meQuery()).data?.user;
  const people = useQuery(errorAssigneesQuery(projectId));
  const change = useMutation({
    mutationFn: (assignee: string | null) =>
      setErrorAssignee(projectId, group.fingerprint, assignee),
    // Pending until both pages show the new assignee.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["errors", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["error", projectId, group.fingerprint] }),
      ]),
  });
  const current: Option = group.assignee ?? NOBODY;
  // The assignee stays listed even if the list has not loaded.
  const options: Option[] = React.useMemo(() => {
    const users = people.data ?? [];
    const listed = users.some((user) => user.id === current.id);
    return [NOBODY, ...(listed || current.id === null ? [] : [current]), ...users];
  }, [people.data, current]);
  const mine = me !== undefined && group.assignee?.id === me.id;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={fieldId} className="text-sm font-normal text-ink-subtle">
          Assignee
        </Label>
        <Combobox
          items={options}
          value={current}
          onValueChange={(next: Option | null) => {
            const id = next?.id ?? null;
            if (id !== current.id) change.mutate(id);
          }}
          itemToStringLabel={(option: Option) => option.name}
          isItemEqualToValue={(a: Option, b: Option) => a.id === b.id}
          autoHighlight
        >
          <ComboboxInput
            id={fieldId}
            className="w-56"
            triggerLabel="Show people"
            placeholder="Search people"
            autoComplete="off"
            spellCheck={false}
            disabled={change.isPending}
          />
          <ComboboxContent>
            <ComboboxEmpty>No one matches</ComboboxEmpty>
            <ComboboxList>
              {(option: Option) => (
                <ComboboxItem key={option.id ?? "nobody"} value={option}>
                  {option.id === null ? (
                    <span className="text-ink-muted">{option.name}</span>
                  ) : (
                    <span className="flex min-w-0 items-center gap-2">
                      <UserAvatar name={option.name} src={option.avatarUrl} size="sm" />
                      <span className="min-w-0 break-words">{option.name}</span>
                    </span>
                  )}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
        {me !== undefined && !mine && (
          <Button
            variant="ghost"
            size="sm"
            disabled={change.isPending}
            onClick={() => change.mutate(me.id)}
          >
            Assign to me
          </Button>
        )}
        {change.isPending && (
          <LoaderCircleIcon aria-label="Saving" className="size-4 animate-spin text-ink-subtle" />
        )}
      </div>
      {change.isError && (
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>The assignee could not be changed</AlertTitle>
          <AlertDescription>{change.error.message}</AlertDescription>
        </Alert>
      )}
      {people.isError && (
        <p className="text-sm text-destructive">The list of people could not load.</p>
      )}
    </div>
  );
}
