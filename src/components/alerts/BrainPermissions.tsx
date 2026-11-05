import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Segmented, Switch } from "@/components/ui/Controls";
import { Select } from "@/components/ui/Select";
import { Input, Textarea } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSpinner } from "@/components/ui/Spinner";
import { SettingGroup, SettingRow } from "@/components/ui/SettingRows";
import { useToast } from "@/components/ui/Toast";
import { changePermission, fetchPermissions, type BotGrant, type BotPermissions, type BotSkill, type Kind, type PermissionChange } from "@/lib/permissionsApi";

// -----------------------------------------------------------------------------
// Alerts > Brain > Permissions (0137): the super admin's alone. What each kind
// of person may have the bot do (admins, members, clients: anyone not on the
// team), the super admin's rules for each kind, and one person's or one
// number's own permissions on top. Every change is saved at once and counts
// from their next message.
// -----------------------------------------------------------------------------

const KINDS: { value: Kind; label: string }[] = [
  { value: "admin", label: "Admins" },
  { value: "member", label: "Members" },
  { value: "client", label: "Outside the team" },
];

const AREAS: { area: BotSkill["area"]; title: string }[] = [
  { area: "talk", title: "Talking to the bot" },
  { area: "read", title: "Reading" },
  { area: "do", title: "Doing things" },
  { area: "system", title: "The system" },
  { area: "client", title: "Clients' own" },
];

type Own = "default" | "allow" | "deny";
const OWN: { value: Own; label: string }[] = [
  { value: "default", label: "As their kind" },
  { value: "allow", label: "Allowed" },
  { value: "deny", label: "Not allowed" },
];

const digits = (v: string) => {
  const d = v.replace(/\D/g, "");
  return /^0\d{10}$/.test(d) ? `2${d}` : d;
};

export function BrainPermissions() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["bot-permissions"], queryFn: fetchPermissions });
  const change = useMutation({
    mutationFn: (p: PermissionChange) => changePermission(p),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["bot-permissions"] }),
    onError: (e: Error) => toast.push({ kind: "error", title: "Not changed", description: e.message }),
  });
  const [view, setView] = useState<"kinds" | "person" | "numbers">("kinds");

  if (q.isLoading) return <PageSpinner />;
  if (q.error || !q.data) return <EmptyState icon={<ShieldCheck size={20} />} title="Permissions" description="Only the super admin sees permissions." />;

  return (
    <div className="pb-24 space-y-6">
      <Segmented
        value={view}
        options={[
          { value: "kinds", label: "Each kind" },
          { value: "person", label: "One person" },
          { value: "numbers", label: "Numbers outside the team" },
        ]}
        onChange={setView}
      />
      {view === "kinds" && <Kinds data={q.data} save={(p) => change.mutate(p)} busy={change.isPending} />}
      {view === "person" && <Person data={q.data} save={(p) => change.mutate(p)} busy={change.isPending} />}
      {view === "numbers" && <Numbers data={q.data} save={(p) => change.mutate(p)} busy={change.isPending} />}
    </div>
  );
}

type Props = { data: BotPermissions; save: (p: PermissionChange) => void; busy: boolean };

const grantable = (d: BotPermissions) => d.skills.filter((s) => s.grantable);

function byArea(skills: BotSkill[]) {
  return AREAS.map((a) => ({ ...a, skills: skills.filter((s) => s.area === a.area) })).filter((a) => a.skills.length);
}

/** Each kind: on or off, the super admin's rules for them, and what they may do by default. */
function Kinds({ data, save, busy }: Props) {
  const [kind, setKind] = useState<Kind>("admin");
  const rules = data.rules.find((r) => r.kind === kind);
  const [draft, setDraft] = useState<Record<Kind, string | undefined>>({ admin: undefined, member: undefined, client: undefined });
  const text = draft[kind] ?? rules?.instructions ?? "";
  const allowed = new Set(data.defaults.filter((d) => d.kind === kind && d.allowed).map((d) => d.skill));
  return (
    <div className="space-y-6">
      <Segmented value={kind} options={KINDS} onChange={setKind} />
      <SettingGroup title="Rules" info="Off: the bot doesn't answer anyone of this kind. The instructions go to the bot with each of their messages.">
        <SettingRow label="The bot answers them" htmlFor={`kind-on-${kind}`}>
          <Switch id={`kind-on-${kind}`} checked={rules?.enabled !== false} onChange={(v) => save({ op: "rules", kind, enabled: v })} label="The bot answers them" disabled={busy} />
        </SettingRow>
        <SettingRow label="Your instructions for them" stack>
          <Textarea rows={4} value={text} onChange={(e) => setDraft((x) => ({ ...x, [kind]: e.target.value }))} placeholder="For example: never promise a delivery date." />
          <div className="mt-2">
            <Button size="sm" variant="primary" disabled={busy || text === (rules?.instructions ?? "")} onClick={() => save({ op: "rules", kind, instructions: text })}>
              Save instructions
            </Button>
          </div>
        </SettingRow>
      </SettingGroup>
      {byArea(grantable(data)).map((a) => (
        <SettingGroup key={a.area} title={a.title}>
          {a.skills.map((s) => (
            <SettingRow key={s.key} label={s.name} info={s.about} htmlFor={`d-${kind}-${s.key}`}>
              <Switch id={`d-${kind}-${s.key}`} checked={allowed.has(s.key)} onChange={(v) => save({ op: "default", kind, skill: s.key, allowed: v })} label={s.name} disabled={busy} />
            </SettingRow>
          ))}
        </SettingGroup>
      ))}
    </div>
  );
}

/** One skill, for one person or number: as their kind, allowed, or not. */
function OwnRows({ data, kind, grants, who, save, busy }: Props & { kind: Kind; grants: BotGrant[]; who: { user_id: string } | { phone: string } }) {
  const defaults = new Set(data.defaults.filter((d) => d.kind === kind && d.allowed).map((d) => d.skill));
  const own = new Map(grants.map((g) => [g.skill, g]));
  return (
    <>
      {byArea(grantable(data)).map((a) => (
        <SettingGroup key={a.area} title={a.title}>
          {a.skills.map((s) => {
            const g = own.get(s.key);
            const value: Own = g ? (g.allowed ? "allow" : "deny") : "default";
            return (
              <SettingRow key={s.key} label={s.name} info={`${s.about}${g?.chats?.length ? ` Only in ${g.chats.length} chat(s).` : ""}`} stack>
                <Segmented
                  value={value}
                  disabled={busy}
                  options={OWN.map((o) => (o.value === "default" ? { ...o, label: `As their kind (${defaults.has(s.key) ? "allowed" : "not allowed"})` } : o))}
                  onChange={(v) => save(v === "default" ? { op: "reset", ...who, skill: s.key } : { op: "grant", ...who, skill: s.key, allowed: v === "allow" })}
                />
              </SettingRow>
            );
          })}
        </SettingGroup>
      ))}
    </>
  );
}

/** Someone on the team: their own permissions on top of their kind's. */
function Person(p: Props) {
  const people = p.data.people.filter((x) => x.id !== p.data.super_admin);
  const [id, setId] = useState<string>("");
  const person = people.find((x) => x.id === id);
  const kind: Kind = person?.role === "admin" ? "admin" : person?.role === "member" ? "member" : "client";
  const grants = p.data.grants.filter((g) => g.user_id === id);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Select className="w-64" aria-label="Someone on the team" placeholder="Pick someone" value={id} onChange={setId} searchable options={people.map((x) => ({ value: x.id, label: `${x.name} (${x.role})` }))} />
        {person && grants.length > 0 && (
          <Button size="sm" variant="ghost" disabled={p.busy} onClick={() => p.save({ op: "reset", user_id: id })}>
            Back to their kind's
          </Button>
        )}
      </div>
      {person && <OwnRows {...p} kind={kind} grants={grants} who={{ user_id: id }} />}
    </div>
  );
}

/** Anyone outside the team, by number: blocked, or given things to do with the bot. */
function Numbers(p: Props) {
  const numbers = useMemo(() => [...new Set(p.data.grants.filter((g) => g.phone).map((g) => g.phone!))], [p.data.grants]);
  const [phone, setPhone] = useState<string>("");
  const [typed, setTyped] = useState("");
  const grants = p.data.grants.filter((g) => g.phone === phone);
  const blocked = grants.some((g) => g.skill === "talk" && !g.allowed);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        {numbers.length > 0 && <Select className="w-56" aria-label="A number" placeholder="A number" value={phone} onChange={setPhone} options={numbers.map((n) => ({ value: n, label: `+${n}` }))} />}
        <Input className="w-56" placeholder="New number, e.g. 01012345678" value={typed} onChange={(e) => setTyped(e.target.value)} />
        <Button size="sm" disabled={!/^[1-9]\d{7,14}$/.test(digits(typed))} onClick={() => (setPhone(digits(typed)), setTyped(""))}>
          Open
        </Button>
      </div>
      {phone && (
        <>
          <SettingGroup title={`+${phone}`}>
            <SettingRow label="Blocked: the bot ignores them" htmlFor="num-block">
              <Switch id="num-block" checked={blocked} onChange={(v) => p.save(v ? { op: "grant", phone, skill: "talk", allowed: false } : { op: "reset", phone, skill: "talk" })} label="Blocked" disabled={p.busy} />
            </SettingRow>
          </SettingGroup>
          <OwnRows {...p} kind="client" grants={grants} who={{ phone }} />
        </>
      )}
    </div>
  );
}
