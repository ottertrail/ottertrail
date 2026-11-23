import * as React from "react";

import { useUnsavedChangesRegistry } from "@/hooks/unsaved-changes";

/**
 * Compares plain values by content. Missing object keys equal undefined values.
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

/** Normalize fields before comparison, such as numeric text or unordered lists. */
export type Normalizers<T> = { [K in keyof T]?: (value: T[K]) => unknown };

/** Sorts set-like lists for comparison. */
export const ignoreOrder = (list: readonly string[]): string[] => list.toSorted();

export interface DirtyForm<T> {
  values: T;
  /** Latest saved values. */
  initial: T;
  /** Becomes false again when edits are undone. */
  dirty: boolean;
  /**
   * The server changed an edited field. The form keeps the user's value.
   */
  conflict: boolean;
  set: <K extends keyof T>(field: K, value: T[K]) => void;
  setValues: (values: T | ((previous: T) => T)) => void;
  /** Restores saved values and clears conflicts. */
  discard: () => void;
  /**
   * Marks submitted values as saved. Edits made during the request stay dirty.
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
  /** Latest server values or values submitted by the last successful save. */
  saved: T;
  /** Last `initial` values, used to detect server changes. */
  server: T;
  values: T;
  conflict: boolean;
  /** Form identity, such as the project ID. */
  key: unknown;
}

/**
 * Keeps local edits when server values change. Conflicts mark fields changed by both.
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
 * Refetches update unedited fields and flag conflicts with local edits.
 * Changing `key` resets the form to `initial` and discards edits.
 * `normalize` controls field comparison. Inside UnsavedChangesGuard,
 * leaving a dirty form asks for confirmation, then discards edits if accepted.
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

  let current = state;
  if (!Object.is(state.key, key)) {
    current = { saved: initial, server: initial, values: initial, conflict: false, key };
    setState(current);
  } else if (!sameValues(initial, state.server)) {
    // Stale `initial` values must not undo a successful save before a refetch.
    current = rebase(state, initial, normalize);
    setState(current);
  }
  const dirty = !sameForm(normalize, current.values, current.saved);

  // Callbacks report to the guard synchronously using the latest state.
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
