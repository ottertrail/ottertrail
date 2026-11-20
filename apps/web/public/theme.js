// The theme, before the first paint (docs/design-system.md, "Color"): the
// choice stored on this device (src/lib/theme.ts, same key), else the
// device's own scheme. A file of its own, loaded without defer, because the
// dashboard's Content Security Policy allows no inline script.
(function () {
  var choice = null;
  try {
    choice = window.localStorage.getItem("ottertrail-theme");
  } catch {
    // Storage unavailable: follow the device.
  }
  var theme =
    choice === "light" || choice === "dark"
      ? choice
      : window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  var root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
  var scheme = document.querySelector('meta[name="color-scheme"]');
  if (scheme) scheme.setAttribute("content", theme);
  var bar = document.querySelector('meta[name="theme-color"]');
  if (bar) bar.setAttribute("content", theme === "dark" ? "#010101" : "#f2eff2");
})();
