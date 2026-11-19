import {
  ChevronDownIcon,
  InboxIcon,
  InfoIcon,
  LoaderCircleIcon,
  OctagonAlertIcon,
  PlusIcon,
  RefreshCwIcon,
  SettingsIcon,
} from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { Section, Specimen } from "./section";

const environments = [
  { label: "Production", value: "production" },
  { label: "Staging", value: "staging" },
  { label: "Development", value: "development" },
];

function ButtonSpecimens() {
  return (
    <div className="space-y-4">
      <Specimen title="Button variants: one primary action per view">
        <Button>Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Delete</Button>
        <Button variant="link">Link</Button>
        <Button disabled>Disabled</Button>
      </Specimen>
      <Specimen title="Button sizes and icons">
        <Button size="xs">Extra small</Button>
        <Button size="sm">Small</Button>
        <Button>Default</Button>
        <Button size="lg">Large</Button>
        <Button>
          <PlusIcon data-icon="inline-start" />
          With icon
        </Button>
        <Button variant="outline" size="icon" aria-label="Settings">
          <SettingsIcon />
        </Button>
        <Button variant="secondary" disabled>
          <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
          Saving
        </Button>
      </Specimen>
      <Specimen title="Badges">
        <Badge>Default</Badge>
        <Badge variant="secondary">Secondary</Badge>
        <Badge variant="outline">Outline</Badge>
        <Badge variant="destructive">Destructive</Badge>
        <StatusBadge tone="good">Resolved</StatusBadge>
        <StatusBadge tone="critical">Unresolved</StatusBadge>
      </Specimen>
    </div>
  );
}

function FormSpecimens() {
  return (
    <Specimen
      title="Form fields: always show labels. Errors state the problem and correction."
      className="block"
    >
      <FieldGroup className="grid max-w-3xl gap-6 md:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="ds-project-name">Project name</FieldLabel>
          <Input id="ds-project-name" placeholder="Marketing site" />
          <FieldDescription>Shown in the dashboard and in installation snippets.</FieldDescription>
        </Field>
        <Field data-invalid="true">
          <FieldLabel htmlFor="ds-allowed-origin">Allowed origin</FieldLabel>
          <Input
            id="ds-allowed-origin"
            defaultValue="example.com"
            aria-invalid="true"
            aria-describedby="ds-allowed-origin-error"
          />
          <FieldError id="ds-allowed-origin-error">
            Include the scheme, for example https://example.com.
          </FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor="ds-environment">Environment</FieldLabel>
          <Select items={environments} defaultValue="production">
            <SelectTrigger id="ds-environment" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {environments.map((environment) => (
                <SelectItem key={environment.value} value={environment.value}>
                  {environment.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="ds-notes">Notes</FieldLabel>
          <Textarea id="ds-notes" placeholder="Optional" />
        </Field>
        <Field orientation="horizontal">
          <Checkbox id="ds-capture-errors" defaultChecked />
          <Label htmlFor="ds-capture-errors">Capture unhandled errors</Label>
        </Field>
        <Field orientation="horizontal">
          <Switch id="ds-mask-inputs" defaultChecked />
          <Label htmlFor="ds-mask-inputs">Mask form inputs</Label>
        </Field>
      </FieldGroup>
    </Specimen>
  );
}

function OverlaySpecimens() {
  return (
    <Specimen title="Overlays and navigation: popovers sit on surface-3 with a hairline ring">
      <Dialog>
        <DialogTrigger render={<Button variant="outline" />}>Open dialog</DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Example dialog</DialogTitle>
            <DialogDescription>
              Dialogs use the popover surface. Keep one primary action and make the escape route
              obvious.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
            <DialogClose render={<Button />}>Confirm</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" />}>
          Menu
          <ChevronDownIcon data-icon="inline-end" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-48">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Example actions</DropdownMenuLabel>
            <DropdownMenuItem>
              Rename
              <DropdownMenuShortcut>R</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem>
              Duplicate
              <DropdownMenuShortcut>D</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Tooltip>
        <TooltipTrigger
          render={<Button variant="ghost" size="icon" aria-label="More information" />}
        >
          <InfoIcon />
        </TooltipTrigger>
        <TooltipContent>
          Tooltips add detail. They must not contain required information.
        </TooltipContent>
      </Tooltip>

      <KbdGroup>
        <Kbd>⌘</Kbd>
        <Kbd>B</Kbd>
      </KbdGroup>
      <span className="text-caption text-ink-subtle">toggles the sidebar</span>

      <Tabs defaultValue="overview" className="w-full">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="text-ink-subtle">
          Segmented tabs for switching views inside a panel.
        </TabsContent>
        <TabsContent value="activity" className="text-ink-subtle">
          Activity panel content.
        </TabsContent>
        <TabsContent value="settings" className="text-ink-subtle">
          Settings panel content.
        </TabsContent>
      </Tabs>
    </Specimen>
  );
}

function DataStateSpecimens() {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card>
        <CardHeader>
          <CardTitle>Loading</CardTitle>
          <CardDescription>Skeletons match the shape of the content they replace.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2" aria-busy="true" aria-label="Loading example">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Empty</CardTitle>
          <CardDescription>Say why there is nothing and what to do next.</CardDescription>
        </CardHeader>
        <CardContent>
          <Empty className="border border-dashed p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <InboxIcon />
              </EmptyMedia>
              <EmptyTitle>No events in this range</EmptyTitle>
              <EmptyDescription>Widen the date range or check the installation.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Failure</CardTitle>
          <CardDescription>
            Report failures plainly. Never show stale data as current.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <OctagonAlertIcon />
            <AlertTitle>Report could not load</AlertTitle>
            <AlertDescription>The query timed out. Try a shorter date range.</AlertDescription>
          </Alert>
        </CardContent>
        <CardFooter className="justify-end">
          <Button variant="secondary" size="sm">
            <RefreshCwIcon data-icon="inline-start" />
            Retry
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

export function ComponentsSection() {
  return (
    <Section
      id="components"
      eyebrow="Components"
      title="Components"
      description="shadcn/ui components on Base UI primitives, themed through the tokens above. The examples on this page are static specimens, not product features."
    >
      <div className="space-y-4">
        <ButtonSpecimens />
        <FormSpecimens />
        <OverlaySpecimens />
        <DataStateSpecimens />
      </div>
    </Section>
  );
}
