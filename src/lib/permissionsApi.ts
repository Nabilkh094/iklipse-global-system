import { supabase } from "@/lib/supabase";

// Bot permissions (0137): what each person may have the bot do, apart from
// their role. The super admin's alone: everyone else is refused by the
// database itself.

export type Kind = "admin" | "member" | "client";

export interface BotSkill {
  key: string;
  name: string;
  about: string;
  area: "talk" | "read" | "do" | "system" | "client";
  grantable: boolean;
  sort: number;
}

export interface BotGrant {
  id: string;
  user_id: string | null;
  phone: string | null;
  skill: string;
  allowed: boolean;
  /** null: everywhere; else 'private' and group chat ids. */
  chats: string[] | null;
  note: string | null;
  updated_at: string;
  name: string | null;
}

export interface BotKindRules {
  kind: Kind;
  enabled: boolean;
  instructions: string;
}

export interface BotPermissions {
  skills: BotSkill[];
  defaults: { kind: Kind; skill: string; allowed: boolean }[];
  grants: BotGrant[];
  rules: BotKindRules[];
  people: { id: string; name: string; role: string }[];
  super_admin: string | null;
}

export type PermissionChange =
  | { op: "grant"; user_id?: string; phone?: string; skill: string; allowed: boolean; chats?: string[] | null; note?: string }
  | { op: "reset"; user_id?: string; phone?: string; skill?: string }
  | { op: "default"; kind: Kind; skill: string; allowed: boolean }
  | { op: "rules"; kind: Kind; enabled?: boolean; instructions?: string };

export async function fetchPermissions(): Promise<BotPermissions> {
  const { data, error } = await supabase.rpc("bot_permissions");
  if (error) throw error;
  return data as BotPermissions;
}

export async function changePermission(p: PermissionChange) {
  const { error } = await supabase.rpc("bot_permissions_set", { p });
  if (error) throw error;
}
