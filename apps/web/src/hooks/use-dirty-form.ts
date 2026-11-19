import * as React from "react";

import { useUnsavedChangesRegistry } from "@/hooks/unsaved-changes";

/**
 * Plain values (strings, numbers, booleans, arrays and objects of them)
 * compared by content. An object's missing key and a key set to undefined
 * are the same.
 */
export function sameValues(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameValues(item, b[index]));
  }
  const aValues = new Map(Object.entries(a));
  const bValues = new Map(Object.entries(b));
  const keys = new Set([...aValues.keys(), ...bValues.keys()]);
  return [...keys].every((key) => sameValues(aValues.get(key), bValues.get(key)));
}

/** Per field, what to compare instead of the value: `Number` for a number typed as text, a sort for a set-like list. */
export type Normalizers<T> = { [K in keyof T]?: (value: T[K]) => unknown };

/** A set-like list (allowed sites, chosen channels) whose order does not count. */
export const ignoreOrder = (list: readonly string[]): string[] => list.toSorted();

export interface DirtyForm<T> {
  /** The values as edited. */
  values: T;
  /** The latest saved values, from the server. */
  initial: T;
  /** Whether the values differ from the saved ones; undoing an edit makes it false again. */
  dirty: boolean;
  /**
   * The server's values changed, while the user edited, in a field the user
   * also edited: the form keeps the user's value and the Save bar says so.
   */
  conflict: boolean;
  /** Changes one field. */
  set: <K extends keyof T>(field: K, value: T[K]) => void;
  /** Replaces the edited values. */
  setValues: (values: T | ((previous: T) => T)) => void;
  /** Puts the latest saved values back, and clears a conflict. */
  discard: () => void;
  /**
   * After a save succeeds: `submitted`, the values the request sent, are now
   * the saved ones. Edits typed while it ran stay, and keep the form dirty.
   */
  saved: (submitted: T) => void;
}

function sameField<T, K extends keyof T>(normalizers: Normalizers<T>, field: K, a: T[K], b: T[K]) {
  const normalize = normalizers[field];
  return normalize === undefined ? sameValues(a, b) : sameValues(normalize(a), normalize(b));
}

function sameForm<T extends object>(normalizers: Normalizers<T>, a: T, b: T): boolean {
  for (const field in a) {
    if (Object.hasOwn(a, field) && !sameField(normalizers, field, a[field], b[field])) return false;
  }
  for (const field in b) {
    if (Object.hasOwn(b, field) && !sameField(normalizers, field, a[field], b[field])) return false;
  }
  return true;
}

interface FormState<T> {
  /** The latest saved values: the server's, or the last ones a save sent. */
  saved: T;
  /** The server's values as last given (`initial`), to see when they change. */
  server: T;
  values: T;
  conflict: boolean;
  /** What the form was opened for, such as the project's ID. */
  key: unknown;
}

/**
 * New saved values from the server: fields the user has not edited take
 * them, edited fields keep the user's value, and an edited field the server
 * also changed is a conflict.
 */
function rebase<T extends object>(state: FormState<T>, next: T, normalizers: Normalizers<T>) {
  const values = { ...next };
  let conflict = state.conflict;
  for (const field in state.values) {
    if (!Object.hasOwn(state.values, field)) continue;
    const edited = !sameField(normalizers, field, state.values[field], state.saved[field]);
    if (!edited) continue;
    values[field] = state.values[field];
    const serverChanged = !sameField(normalizers, field, next[field], state.saved[field]);
    if (serverChanged && !sameField(normalizers, field, next[field], state.values[field])) {
      conflict = true;
    }
  }
  return { ...state, saved: next, server: next, values, conflict };
}

/**
 * A settings form's edits against what is saved.
 *
 * - `initial` is the server's latest values. A new `initial` (a refetch)
 *   always becomes the saved values; fields the user has not edited follow
 *   it, and an edited field the server also changed sets `conflict`.
 * - `key` names what the form is for (the project's ID): when it changes,
 *   the form starts again from `initial`, edits and all dropped.
 * - `normalize` compares a field by something other than its value.
 * - Inside an `UnsavedChangesGuard`, a dirty form makes leaving the page ask
 *   first, and leaving anyway discards its edits.
 */
export function useDirtyForm<T extends object>(
  initial: T,
  { key, normalize = {} }: { key?: unknown; normalize?: Normalizers<T> } = {},
): DirtyForm<T> {
  const [state, setState] = React.useState<FormState<T>>(() => ({
    saved: initial,
    server: initial,
    values: initial,
    conflict: false,
    key,
  }));
  const normalizersRef = React.useRef(normalize);

  // Another project (key), or new values from the server (initial): adjusted while rendering.
  let current = state;
  if (!Object.is(state.key, key)) {
    current = { saved: initial, server: initial, values: initial, conflict: false, key };
    setState(current);
  } else if (!sameValues(initial, state.server)) {
    // Only a change from the server counts: right after a save, the server's old values
    // are still `initial` until its answer arrives, and must not undo the save.
    current = rebase(state, initial, normalize);
    setState(current);
  }
  const dirty = !sameForm(normalize, current.values, current.saved);

  // The latest state, for the callbacks below, which report to the guard at once.
  const stateRef = React.useRef(current);
  React.useLayoutEffect(() => {
    stateRef.current = current;
    normalizersRef.current = normalize;
  });
  const id = React.useId();
  const registry = useUnsavedChangesRegistry();
  const update = React.useCallback(
    (change: (previous: FormState<T>) => FormState<T>) => {
      const next = change(stateRef.current);
      stateRef.current = next;
      setState(next);
      registry?.report(id, !sameForm(normalizersRef.current, next.values, next.saved));
    },
    [registry, id, normalizersRef, stateRef, setState],
  );

  const discard = React.useCallback(
    () => update((previous) => ({ ...previous, values: previous.saved, conflict: false })),
    [update],
  );
  React.useEffect(() => {
    registry?.report(id, dirty);
  }, [registry, id, dirty]);
  React.useEffect(() => {
    const unregister = registry?.register(id, discard);
    return () => {
      unregister?.();
      registry?.report(id, false);
    };
  }, [registry, id, discard]);

  const set = React.useCallback(
    <K extends keyof T>(field: K, value: T[K]) =>
      update((previous) => ({ ...previous, values: { ...previous.values, [field]: value } })),
    [update],
  );
  const setValues = React.useCallback(
    (values: T | ((previous: T) => T)) =>
      update((previous) => ({
        ...previous,
        values: typeof values === "function" ? values(previous.values) : values,
      })),
    [update],
  );
  const saved = React.useCallback(
    (submitted: T) => update((previous) => ({ ...previous, saved: submitted, conflict: false })),
    [update],
  );

  return {
    values: current.values,
    initial: current.saved,
    dirty,
    conflict: current.conflict,
    set,
    setValues,
    discard,
    saved,
  };
}
