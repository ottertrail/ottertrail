/** "⌘" on Apple systems, "Ctrl" elsewhere: the modifier the app's shortcuts take. */
export function modifierKey(): string {
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform;
  return /mac|iphone|ipad/i.test(platform) ? "⌘" : "Ctrl";
}

/**
 * Whether a key press belongs to a text field, a menu or a dialog, where a
 * screen's single-key shortcuts (j, k, Esc) must not act.
 */
export function typingOrOverlay(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
    return true;
  }
  const target = event.target instanceof Element ? event.target : null;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  if (
    target?.closest(
      // A combobox counts only as a text field or while its list is open: a closed
      // Select's trigger is a button, and the keys work after choosing in it.
      "input, textarea, select, [role=combobox][aria-expanded=true], [role=listbox], [role=menu], [role=dialog], [role=alertdialog]",
    )
  ) {
    return true;
  }
  // Base UI keeps focus in a popup it opened; any open modal also counts.
  return document.querySelector("[role=dialog][data-open], [role=alertdialog][data-open]") !== null;
}
