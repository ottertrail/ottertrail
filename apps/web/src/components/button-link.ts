import { createLink } from "@tanstack/react-router";

import { ButtonAnchor } from "./button-anchor";

/** Preserve link semantics. Base UI Button rendered as a link gives it a button role. */
export const ButtonLink = createLink(ButtonAnchor);
