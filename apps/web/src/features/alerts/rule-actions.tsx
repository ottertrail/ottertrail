import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoaderCircleIcon, OctagonAlertIcon, PencilIcon, Trash2Icon } from "lucide-react";
import * as React from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
  type ChannelName,
  deleteRule,
  type Rule,
  type SaveWarning,
  updateRule,
} from "@/lib/alerts-api";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

import { RuleFormDialog } from "./rule-form-dialog";

export type SavedWarning = { ruleName: string; warning: SaveWarning | null };

function DeleteRuleDialog({
  projectId,
  rule,
  open,
  onOpenChange,
  onDeleted,
}: {
  projectId: string;
  rule: Rule;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: (() => void) | undefined;
}) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: async () => {
      try {
        await deleteRule(projectId, rule.id);
      } catch (error) {
        // Treat deletion in another tab as success.
        if (!(error instanceof ApiError && error.code === "rule_not_found")) throw error;
      }
    },
    onSuccess: () => {
      onOpenChange(false);
      onDeleted?.();
      void queryClient.invalidateQueries({ queryKey: ["alerts", projectId] });
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) remove.reset();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete the rule “{rule.name}”?</DialogTitle>
          <DialogDescription>
            This stops notifications and removes the rule's alerts from history. To stop the rule
            temporarily, disable it.
          </DialogDescription>
        </DialogHeader>
        {remove.error !== null && (
          <Alert variant="destructive" role="alert">
            <OctagonAlertIcon />
            <AlertDescription>{remove.error.message}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
          <Button variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
            {remove.isPending && (
              <LoaderCircleIcon
                aria-hidden="true"
                className="animate-spin motion-reduce:animate-none"
              />
            )}
            Delete rule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Save immediately, per docs/design-system.md, "The save rule". */
export function RuleSwitch({
  projectId,
  rule,
  canManage,
}: {
  projectId: string;
  rule: Rule;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateRule(projectId, rule.id, { enabled }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["alerts", projectId] }),
  });
  return (
    <>
      <Switch
        aria-label={rule.enabled ? `Turn off ${rule.name}` : `Turn on ${rule.name}`}
        checked={rule.enabled}
        disabled={!canManage || toggle.isPending}
        onCheckedChange={(checked) => toggle.mutate(checked)}
      />
      {toggle.error !== null && (
        <p role="alert" className="mt-1 max-w-60 text-xs text-destructive">
          {toggle.error.message}
        </p>
      )}
    </>
  );
}

export function RuleActions({
  projectId,
  rule,
  checks,
  channels,
  onWarning,
  onDeleted,
  canManage,
  compact = false,
}: {
  projectId: string;
  rule: Rule;
  checks: readonly { id: string; name: string }[];
  channels: readonly ChannelName[];
  onWarning: (saved: SavedWarning) => void;
  onDeleted?: () => void;
  canManage: boolean;
  compact?: boolean;
}) {
  const [editing, setEditing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  if (!canManage) return null;
  return (
    <>
      <div className={cn("flex items-center gap-1", !compact && "flex-wrap")}>
        <Button
          variant={compact ? "ghost" : "outline"}
          size={compact ? "icon-sm" : "sm"}
          aria-label={compact ? `Edit ${rule.name}` : undefined}
          onClick={() => setEditing(true)}
        >
          <PencilIcon aria-hidden="true" />
          {!compact && "Edit"}
        </Button>
        <Button
          variant={compact ? "ghost" : "outline"}
          size={compact ? "icon-sm" : "sm"}
          aria-label={compact ? `Delete ${rule.name}` : undefined}
          onClick={() => setDeleting(true)}
        >
          <Trash2Icon aria-hidden="true" />
          {!compact && "Delete"}
        </Button>
      </div>
      <RuleFormDialog
        open={editing}
        onOpenChange={setEditing}
        projectId={projectId}
        rule={rule}
        checks={checks}
        channels={channels}
        onWarning={onWarning}
      />
      <DeleteRuleDialog
        projectId={projectId}
        rule={rule}
        open={deleting}
        onOpenChange={setDeleting}
        onDeleted={onDeleted}
      />
    </>
  );
}
