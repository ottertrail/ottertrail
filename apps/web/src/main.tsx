import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles/globals.css";
import { watchTheme } from "./lib/theme.ts";
import { createAppRouter } from "./router.tsx";

// Keep the theme set by public/theme.js current after the first paint.
watchTheme();

const router = createAppRouter();
const root = document.getElementById("root");
if (root === null) {
  throw new Error("Missing #root element in index.html");
}

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
