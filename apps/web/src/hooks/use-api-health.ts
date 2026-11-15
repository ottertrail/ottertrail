import * as React from "react";

import { type ApiHealth, fetchApiHealth } from "@/lib/api-health";

export type ApiHealthState = { state: "checking" } | ApiHealth;

function ignoreAbort() {
  // fetchApiHealth rejects only when its request is aborted by a newer check or unmount.
}

export function useApiHealth() {
  const [health, setHealth] = React.useState<ApiHealthState>({ state: "checking" });
  const controllerRef = React.useRef<AbortController | null>(null);

  const check = React.useCallback(() => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    fetchApiHealth(controller.signal).then(setHealth, ignoreAbort);
  }, []);

  React.useEffect(() => {
    check();
    return () => controllerRef.current?.abort();
  }, [check]);

  const retry = React.useCallback(() => {
    setHealth({ state: "checking" });
    check();
  }, [check]);

  return { health, retry };
}
