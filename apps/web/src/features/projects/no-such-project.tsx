import { FolderXIcon } from "lucide-react";

import { ButtonLink } from "@/components/button-link";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

export function NoSuchProject() {
  return (
    <Empty className="m-6 border border-dashed p-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FolderXIcon />
        </EmptyMedia>
        <EmptyTitle>No such project</EmptyTitle>
        <EmptyDescription>It may have been removed, or the link is wrong.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <ButtonLink variant="outline" to="/projects">
          All projects
        </ButtonLink>
      </EmptyContent>
    </Empty>
  );
}
