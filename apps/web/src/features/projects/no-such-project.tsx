import { NotFound } from "@/components/route-states";

/**
 * A project that does not exist, or one the person may not reach: the API
 * answers both with a 404, so the page cannot tell them apart either.
 */
export function NoSuchProject() {
  return (
    <NotFound
      placement="shell"
      title="Project not found"
      line="It may have been deleted, or you may not have access."
    />
  );
}
