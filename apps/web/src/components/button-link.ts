import { createLink } from "@tanstack/react-router";

import { ButtonAnchor } from "./button-anchor";

/**
 * A router link that looks like a button. It stays a link: screen readers
 * announce it as one, and it opens in a new tab like any link. (Base UI's
 * Button rendered as a link would be announced as a button.)
 */
export const ButtonLink = createLink(ButtonAnchor);
