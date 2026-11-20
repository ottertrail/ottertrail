import { Sealer } from "../auth/sealer.ts";

/**
 * Seals the links queued account emails carry (account-emails.ts), so a
 * dump of the database taken while one waits holds no working invitation
 * or reset link: AES-256-GCM, with a key derived from AUTH_SECRET by HKDF
 * (auth/sealer.ts). Whoever has AUTH_SECRET as well can open them;
 * changing AUTH_SECRET makes the queued ones unreadable, and those emails
 * are given up.
 *
 * A sealed link is bound to its email's kind and address (the GCM
 * additional data), so it cannot be moved to another row.
 */
export class LinkSealer extends Sealer {
  constructor(secret: string) {
    super(secret, "ottertrail account email links v1");
  }
}

/** What a sealed link is bound to: its email's kind and address. */
export const sealBinding = (kind: string, to: string) => `${kind}\n${to}`;
