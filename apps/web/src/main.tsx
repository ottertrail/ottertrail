import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles/globals.css";
import { watchTheme } from "./lib/theme.ts";
import { createAppRouter } from "./router.tsx";

// public/theme.js set the theme before the first paint; this keeps it in step.
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
