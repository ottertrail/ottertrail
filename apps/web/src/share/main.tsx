import { createBrowserHistory } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "../styles/globals.css";
import { watchTheme } from "../lib/theme.ts";
import { ShareRoot } from "./share-root.tsx";

// Keep the theme set by public/theme.js current after the first paint.
watchTheme();

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Missing #root element in share.html");
}

createRoot(root).render(
  <StrictMode>
    <ShareRoot history={createBrowserHistory()} />
  </StrictMode>,
);
