import { Sealer } from "../auth/sealer.ts";

/**
 * Seal queued invitation and reset links with AES-256-GCM using an HKDF key from AUTH_SECRET
 * (auth/sealer.ts; account-emails.ts). A database dump alone cannot open them. Changing
 * AUTH_SECRET makes queued links unreadable and their emails are abandoned. Bind links to email
 * kind and address to prevent moving them between rows.
 */
export class LinkSealer extends Sealer {
  constructor(secret: string) {
    super(secret, "ottertrail account email links v1");
  }
}

export const sealBinding = (kind: string, to: string) => `${kind}\n${to}`;
