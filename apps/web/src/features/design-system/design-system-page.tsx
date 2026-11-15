import { ComponentsSection } from "./components-section";
import { ColorSection, ShapeSection, TypographySection } from "./foundations";

const contents = [
  { id: "color", label: "Color" },
  { id: "typography", label: "Typography" },
  { id: "shape", label: "Shape and spacing" },
  { id: "components", label: "Components" },
];

export function DesignSystemPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-16 px-6 py-10 md:px-10">
      <header className="max-w-3xl space-y-4">
        <p className="text-eyebrow text-ink-subtle">Ottertrail UI</p>
        <p className="text-display-md text-ink">Design system</p>
        <p className="text-body-lg text-ink-subtle">
          A dense, dark interface for analytics, debugging, and email work: restrained surfaces,
          hairline borders, and one accent color used with intent.
        </p>
        <nav aria-label="On this page">
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {contents.map((item) => (
              <li key={item.id}>
                <a href={`#${item.id}`} className="text-link underline-offset-4 hover:underline">
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <ColorSection />
      <TypographySection />
      <ShapeSection />
      <ComponentsSection />
    </div>
  );
}
