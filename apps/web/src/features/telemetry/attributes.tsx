import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** Render stored values as text; arrays are JSON. */
export function AttributeTable({
  caption,
  attributes,
  empty = "None.",
}: {
  caption: string;
  attributes: Record<string, string>;
  empty?: string;
}) {
  const entries = Object.entries(attributes).toSorted(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return <p className="text-sm text-ink-subtle">{empty}</p>;
  }
  return (
    <Table className="table-fixed">
      <caption className="sr-only">{caption}</caption>
      <TableHeader>
        <TableRow>
          <TableHead className="w-2/5">Key</TableHead>
          <TableHead>Value</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map(([key, value]) => (
          <TableRow key={key}>
            <TableCell className="align-top font-mono text-xs break-all whitespace-normal text-ink-muted">
              {key}
            </TableCell>
            <TableCell className="font-mono text-xs break-all whitespace-pre-wrap text-ink">
              {value === "" ? <span className="font-sans text-ink-subtle">(empty)</span> : value}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
