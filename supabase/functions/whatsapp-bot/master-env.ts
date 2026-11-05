// The master channel's switch (master.ts): on once MASTER_SECRET (a Supabase
// secret, 32 characters at least) is set. Kept apart so brain.ts can read it
// without the rest of master.ts.

import { env } from "./kit.ts";

/** The super admin's master group, as the bot knows it: a chat that isn't on WhatsApp. */
export const MASTER_CHAT = "master@iklipse";

export const masterSecret = (get: (k: string) => string = (k) => env(k)) => get("MASTER_SECRET");

/** Set up: what was for the super admin's private chat goes to the master group instead. */
export const masterOn = (get?: (k: string) => string) => masterSecret(get).length >= 32;
