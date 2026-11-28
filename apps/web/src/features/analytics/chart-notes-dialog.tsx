import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoaderCircleIcon, OctagonAlertIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import * as React from "react";

import { DateField } from "@/components/date-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldContent, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  type Annotation,
  createAnnotation,
  deleteAnnotation,
  MAX_NOTE_LENGTH,
  noteTextProblem,
  updateAnnotation,
} from "@/lib/annotations-api";
import { ApiError } from "@/lib/api";

import { MarksList } from "./chart-marks";
import type { PointMarks } from "./chart-marks-data";

/*
 * Adding, changing, and deleting the chart's notes (chart-marks.tsx), for
 * those who manage goals (docs/access.md). Loaded when it first opens.
 */

interface Point {
  /** "Tue 17 Nov", "Tue 17 Nov, 14:00", or "16 Nov to 22 Nov". */
  label: string;
  /** A new note's day and time. */
  day: string;
  time: string | null;
}

function NoteForm({
  projectId,
  environment,
  point,
  note,
  onDone,
}: {
  projectId: string;
  environment: string;
  point: Point;
  /** The note to change; undefined for a new one. */
  note: Annotation | undefined;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [day, setDay] = React.useState(note?.day ?? point.day);
  const [time, setTime] = React.useState(note?.time ?? point.time ?? "");
  const [text, setText] = React.useState(note?.text ?? "");
  const [everywhere, setEverywhere] = React.useState(
    note === undefined ? true : note.environment === null,
  );
  const [checked, setChecked] = React.useState(false);
  const ids = { day: React.useId(), time: React.useId(), text: React.useId(), env: React.useId() };
  const save = useMutation({
    mutationFn: () => {
      const fields = {
        day,
        time: time === "" ? null : time,
        text: text.trim(),
        environment: everywhere ? null : (note?.environment ?? environment),
      };
      return note === undefined
        ? createAnnotation(projectId, fields)
        : updateAnnotation(projectId, note.id, fields);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["annotations", projectId] });
      onDone();
    },
  });
  const textProblem = noteTextProblem(text);
  const dayProblem = day === "" ? "Choose the day." : null;
  const shownText = checked ? textProblem : null;
  const shownDay = checked ? dayProblem : null;

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setChecked(true);
        if (textProblem === null && dayProblem === null && !save.isPending) save.mutate();
      }}
    >
      <Field data-invalid={shownText !== null || undefined}>
        <FieldLabel htmlFor={ids.text}>Note</FieldLabel>
        <Input
          id={ids.text}
          value={text}
          placeholder="Launched the new pricing page"
          autoComplete="off"
          maxLength={MAX_NOTE_LENGTH}
          aria-invalid={shownText !== null || undefined}
          aria-describedby={shownText === null ? undefined : `${ids.text}-error`}
          onChange={(event) => setText(event.target.value)}
        />
        {shownText !== null && <FieldError id={`${ids.text}-error`}>{shownText}</FieldError>}
      </Field>
      <div className="flex flex-wrap gap-4">
        <Field data-invalid={shownDay !== null || undefined} className="w-auto">
          <FieldLabel htmlFor={ids.day}>Day</FieldLabel>
          <DateField
            id={ids.day}
            label="Day"
            value={day}
            onChange={setDay}
            invalid={shownDay !== null}
            describedBy={shownDay === null ? undefined : `${ids.day}-error`}
            className="w-44"
          />
          {shownDay !== null && <FieldError id={`${ids.day}-error`}>{shownDay}</FieldError>}
        </Field>
        <Field className="w-auto">
          <FieldLabel htmlFor={ids.time}>Time (optional)</FieldLabel>
          <Input
            id={ids.time}
            type="time"
            step={60}
            value={time}
            onChange={(event) => setTime(event.target.value)}
            className="w-32"
          />
        </Field>
      </div>
      <Field orientation="horizontal">
        <Checkbox
          id={ids.env}
          checked={everywhere}
          onCheckedChange={(next) => setEverywhere(next)}
        />
        <FieldContent>
          <FieldLabel htmlFor={ids.env}>Show in every environment</FieldLabel>
        </FieldContent>
      </Field>
      {save.error !== null && (
        <Alert variant="destructive" role="alert">
          <OctagonAlertIcon />
          <AlertDescription>{save.error.message}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <Button variant="outline" type="button" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
          {note === undefined ? "Add note" : "Save note"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function NoteRow({
  projectId,
  note,
  onEdit,
}: {
  projectId: string;
  note: Annotation;
  onEdit: () => void;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = React.useState(false);
  const remove = useMutation({
    mutationFn: async () => {
      try {
        await deleteAnnotation(projectId, note.id);
      } catch (error) {
        // Deleted in another tab: the same outcome.
        if (!(error instanceof ApiError && error.code === "annotation_not_found")) throw error;
      }
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["annotations", projectId] }),
  });
  return (
    <li className="flex flex-col gap-2 border-t py-2 first:border-t-0">
      <div className="flex items-start justify-between gap-2">
        <MarksList marks={{ notes: [note], releases: [] }} className="min-w-0 text-sm" />
        {!confirming && (
          <div className="flex shrink-0 gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Edit the note ${note.text}`}
              onClick={onEdit}
            >
              <PencilIcon aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Delete the note ${note.text}`}
              onClick={() => setConfirming(true)}
            >
              <Trash2Icon aria-hidden="true" />
            </Button>
          </div>
        )}
      </div>
      {confirming && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-sm text-ink-muted">Delete this note?</span>
          <Button variant="outline" size="sm" onClick={() => setConfirming(false)}>
            Keep it
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
            Delete note
          </Button>
        </div>
      )}
      {remove.error !== null && (
        <Alert variant="destructive" role="alert">
          <OctagonAlertIcon />
          <AlertDescription>{remove.error.message}</AlertDescription>
        </Alert>
      )}
    </li>
  );
}

/**
 * A point's notes and releases, with a form to add a note there, or to
 * change one. `adding` opens straight on the form.
 */
export function NotesDialog({
  projectId,
  environment,
  point,
  marks,
  adding,
  onClose,
}: {
  projectId: string;
  environment: string;
  point: Point;
  marks: PointMarks;
  adding: boolean;
  onClose: () => void;
}) {
  const empty = marks.notes.length === 0 && marks.releases.length === 0;
  // "new", a note's ID, or null for the point's list.
  const [editing, setEditing] = React.useState<string | null>(adding || empty ? "new" : null);
  const note = marks.notes.find((item) => item.id === editing);
  const formOpen = editing === "new" || note !== undefined;
  const back = () => (adding || empty ? onClose() : setEditing(null));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing === "new" ? "Add a note" : note === undefined ? "Notes" : "Edit the note"}
          </DialogTitle>
          <DialogDescription>{point.label}</DialogDescription>
        </DialogHeader>
        {formOpen ? (
          <NoteForm
            key={editing}
            projectId={projectId}
            environment={environment}
            point={point}
            note={note}
            onDone={back}
          />
        ) : (
          <>
            <ul className="flex flex-col">
              {marks.notes.map((item) => (
                <NoteRow
                  key={item.id}
                  projectId={projectId}
                  note={item}
                  onEdit={() => setEditing(item.id)}
                />
              ))}
            </ul>
            {marks.releases.length > 0 && (
              <MarksList marks={{ notes: [], releases: marks.releases }} className="text-sm" />
            )}
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
              <Button onClick={() => setEditing("new")}>
                <PlusIcon aria-hidden="true" />
                Add note
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
