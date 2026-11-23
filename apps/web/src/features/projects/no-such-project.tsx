import { NotFound } from "@/components/route-states";

/** The API uses 404 for both missing and inaccessible projects. */
export function NoSuchProject() {
  return (
    <NotFound
      placement="shell"
      title="Project not found"
      line="It may have been deleted, or you may not have access."
    />
  );
}
