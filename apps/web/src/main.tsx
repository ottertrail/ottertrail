import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles/globals.css";
import { App } from "./app.tsx";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Missing #root element in index.html");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
