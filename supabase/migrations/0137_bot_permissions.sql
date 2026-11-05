-- 0137_bot_permissions.sql
--   What each person may have the bot do: apart from their role in the app.
--   - bot_skill: everything the bot can do, one row each (a tool of the brain,
--     plus talk: talking to the bot at all, and dev: files and the shell in
--     their private chat).
--   - bot_default: what each kind of person may do (admin, member, client:
--     anyone not on the team). Filled with exactly what happens today.
--   - bot_grant: one person's own, on top of their kind's: by account (the
--     team) or by number (anyone else), allowed or not, optionally only in some
--     chats ('private' for their private chat, or group ids).
--   - bot_kind_rules: each kind on or off, and the super admin's own
--     instructions for them (said with every message).
--   The super admin has everything, always. Only they see or change any of it:
--   no access for the site's keys; the site goes through bot_permissions() and
--   bot_permissions_set(), the bot checks the asker in its own code.
--   Read fresh with every message and every tool call: a change counts at once.

create table if not exists public.bot_skill (
  key        text primary key check (key ~ '^[a-z_]{2,40}$'),
  name       text not null,
  about      text not null default '',
  area       text not null default 'do' check (area in ('talk', 'read', 'do', 'system', 'client')),
  -- false: the super admin's alone, never given to anyone (permissions).
  grantable  boolean not null default true,
  sort       int not null default 100
);

create table if not exists public.bot_default (
  kind    text not null check (kind in ('admin', 'member', 'client')),
  skill   text not null references public.bot_skill(key) on delete cascade,
  allowed boolean not null,
  primary key (kind, skill)
);

create table if not exists public.bot_grant (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references public.profile(id) on delete cascade,
  phone      text check (phone ~ '^[1-9][0-9]{7,14}$'),
  skill      text not null references public.bot_skill(key) on delete cascade,
  allowed    boolean not null,
  -- null: everywhere. Else only in these chats: 'private' (their private chat) or a group's chat id.
  chats      text[],
  note       text,
  updated_at timestamptz not null default now(),
  check ((user_id is null) <> (phone is null))
);
create unique index if not exists bot_grant_who_skill on public.bot_grant (coalesce(user_id::text, phone), skill);
create index if not exists bot_grant_user_idx on public.bot_grant (user_id);
create index if not exists bot_grant_phone_idx on public.bot_grant (phone);

create table if not exists public.bot_kind_rules (
  kind         text primary key check (kind in ('admin', 'member', 'client')),
  enabled      boolean not null default true,
  instructions text not null default '',
  updated_at   timestamptz not null default now()
);

alter table public.bot_skill enable row level security;
alter table public.bot_default enable row level security;
alter table public.bot_grant enable row level security;
alter table public.bot_kind_rules enable row level security;
revoke all on public.bot_skill, public.bot_default, public.bot_grant, public.bot_kind_rules from anon, authenticated;

-- ------------------------------------------------------------ the skills --
insert into public.bot_skill (key, name, about, area, grantable, sort) values
  ('talk',                'Talk to the bot',          'Off: the bot ignores them completely.', 'talk', true, 1),
  ('find',                'Look things up',           'Read iklipse''s tables (projects, clients, orders...) as they may.', 'read', true, 10),
  ('search',              'Search',                   'Search messages, mail, files and notes.', 'read', true, 11),
  ('overview',            'What''s going on',         'Open alerts, meetings, orders, who''s working today.', 'read', true, 12),
  ('free_times',          'Free times',               'Free times on their calendar.', 'read', true, 13),
  ('reminders',           'Their reminders',          'See their own reminders.', 'read', true, 14),
  ('orders',              'Orders',                   'See the orders the bot carries on.', 'read', true, 15),
  ('boards_tools',        'Board tools list',         'Which Trello and Miro tools there are.', 'read', true, 16),
  ('boards',              'Read boards',              'Read Trello and Miro boards.', 'read', true, 17),
  ('taught',              'What the bot was taught',  'Read the notes the team taught the bot.', 'read', true, 18),
  ('brain_log',           'The bot''s log',           'Read what the bot did and who asked.', 'read', true, 19),
  ('boards_change',       'Change boards',            'Add, move and change cards and items on boards.', 'do', true, 30),
  ('message_team_member', 'Message the team',         'Have the bot message someone on the team.', 'do', true, 31),
  ('message_client',      'Message clients',          'Have the bot message a client.', 'do', true, 32),
  ('post_in_group',       'Post in groups',           'Have the bot post in a WhatsApp group.', 'do', true, 33),
  ('meeting',             'Meetings',                 'Book, move or cancel meetings, send booking links.', 'do', true, 34),
  ('set_reminder',        'Set reminders',            'Set reminders for themselves or others.', 'do', true, 35),
  ('cancel_reminders',    'Cancel reminders',         'Cancel reminders.', 'do', true, 36),
  ('group_report',        'Repeating reports',        'Reports every so often about a group, a person or emails.', 'do', true, 37),
  ('transcripts',         'Transcripts',              'Write out voice notes and meetings into a file.', 'do', true, 38),
  ('close_alert',         'Close alerts',             'Close an alert.', 'do', true, 39),
  ('alert_pause',         'Pause alerts',             'Pause alerts for a group or a client.', 'do', true, 40),
  ('order_update',        'Answer orders',            'Answer or update an order the bot carries on.', 'do', true, 41),
  ('order_follow',        'Follow up orders',         'Relay, remind, close or stop following an order.', 'do', true, 42),
  ('client_details',      'Clients'' details',        'Save clients'' names, emails, numbers.', 'do', true, 43),
  ('client_chat',         'Answer for clients',       'Decide the bot''s reply to a client it couldn''t answer alone.', 'do', true, 44),
  ('remember',            'Teach the bot',            'Teach the bot a note.', 'do', true, 45),
  ('forget',              'Make it forget',           'Forget taught notes.', 'do', true, 46),
  ('team_member',         'Change people',            'Change someone on the team: role, left, name, numbers, email.', 'do', true, 47),
  ('bot_settings',        'Bot settings',             'Change Alerts > Settings.', 'system', true, 60),
  ('brain_settings',      'Brain settings',           'Change the brain''s own settings (phase, models, limits).', 'system', true, 61),
  ('dev',                 'Files and shell',          'Read and change the code, run commands (their private chat only).', 'system', true, 62),
  ('github_status',       'GitHub status',            'See branches, PRs and checks.', 'system', true, 63),
  ('push_branch',         'Push a branch',            'Push code to a branch.', 'system', true, 64),
  ('install_deps',        'Install packages',         'Install the code''s packages.', 'system', true, 65),
  ('open_pr',             'Open PRs',                 'Open a pull request.', 'system', true, 66),
  ('merge_pr',            'Merge PRs',                'Merge a pull request.', 'system', true, 67),
  ('deploy',              'Deploy',                   'Deploy the functions or the database.', 'system', true, 68),
  ('rollback',            'Roll back',                'Go back to the deploy before.', 'system', true, 69),
  ('deploy_brain',        'Update the bot',           'Update the brain itself.', 'system', true, 70),
  ('close_pr',            'Close PRs',                'Give up on a change.', 'system', true, 71),
  ('skills_list',         'See skills',               'See the bot''s skills.', 'system', true, 72),
  ('skill_add',           'Add skills',               'Add a skill from a .md file.', 'system', true, 73),
  ('skill_remove',        'Remove skills',            'Remove an added skill.', 'system', true, 74),
  ('client_meeting',      'Their own meeting',        'A client books a call with the team.', 'client', true, 90),
  ('ask_team',            'Ask the team',             'A client''s question goes to the team when the bot is stuck.', 'client', true, 91),
  ('permissions',         'Permissions',              'Who may have the bot do what. The super admin''s alone.', 'system', false, 99)
on conflict (key) do nothing;

-- ------------------------------------------- day one: exactly today's rules --
-- admin: every tool admins have today (and files and the shell privately).
insert into public.bot_default (kind, skill, allowed)
select 'admin', k, true from unnest(array[
  'talk', 'find', 'search', 'overview', 'free_times', 'reminders', 'orders', 'boards_tools', 'boards', 'taught', 'brain_log',
  'boards_change', 'message_team_member', 'message_client', 'post_in_group', 'meeting', 'set_reminder', 'cancel_reminders',
  'group_report', 'transcripts', 'close_alert', 'alert_pause', 'order_update', 'order_follow', 'client_details', 'client_chat',
  'remember', 'forget', 'team_member', 'bot_settings', 'dev', 'github_status', 'push_branch', 'install_deps', 'open_pr',
  'merge_pr', 'deploy', 'rollback', 'deploy_brain', 'close_pr', 'skills_list'
]) k
on conflict do nothing;
-- member: they ask; they answer what the bot asked them.
insert into public.bot_default (kind, skill, allowed)
select 'member', k, true from unnest(array[
  'talk', 'find', 'search', 'overview', 'free_times', 'reminders', 'orders', 'boards_tools', 'boards',
  'order_update', 'client_details', 'client_chat'
]) k
on conflict do nothing;
-- client (anyone not on the team): only what's theirs.
insert into public.bot_default (kind, skill, allowed)
select 'client', k, true from unnest(array['talk', 'order_update', 'client_meeting', 'ask_team']) k
on conflict do nothing;
-- Everything else: not allowed, written down so the page shows it.
insert into public.bot_default (kind, skill, allowed)
select k.kind, s.key, false from public.bot_skill s cross join (values ('admin'), ('member'), ('client')) k(kind)
 where s.grantable
on conflict do nothing;

insert into public.bot_kind_rules (kind) values ('admin'), ('member'), ('client') on conflict do nothing;

-- -------------------------------------------------------- what they have --
-- What someone may have the bot do now, in this chat. p_user: their account (the team), else null;
-- p_phone: their number (anyone); p_kind: admin, member or client; p_chat: where (a private chat or a group id).
create or replace function public.bot_skills_for(p_user uuid, p_phone text, p_kind text, p_chat text)
returns text[] language plpgsql stable security definer set search_path = public as $$
declare
  v_super uuid := (select super_admin from public.brain_settings where id = 1);
  v_private boolean := coalesce(p_chat, '') not like '%@g.us';
  v_phone text := nullif(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), '');
  v_out text[];
begin
  if p_user is not null and p_user = v_super then
    return (select array_agg(key order by sort) from public.bot_skill);
  end if;
  if not coalesce((select enabled from public.bot_kind_rules where kind = p_kind), true) then
    return '{}';
  end if;
  with base as (
    select d.skill, d.allowed from public.bot_default d where d.kind = p_kind
  ), mine as (
    select g.skill, g.allowed,
           (g.chats is null or (v_private and 'private' = any(g.chats)) or p_chat = any(g.chats)) as here
      from public.bot_grant g
     where (p_user is not null and g.user_id = p_user) or (v_phone is not null and g.phone = v_phone)
  )
  select coalesce(array_agg(s.key order by s.sort), '{}') into v_out
    from public.bot_skill s
   where s.grantable
     and (
       -- Their own grant for this chat wins.
       coalesce(
         (select bool_and(m.allowed) from mine m where m.skill = s.key and m.here),
         -- An "allowed" grant for other chats only: not here. A "not allowed" one elsewhere: the default here.
         case when exists (select 1 from mine m where m.skill = s.key and m.allowed and not m.here) then false end,
         (select b.allowed from base b where b.skill = s.key),
         false
       )
     );
  return v_out;
end $$;
revoke all on function public.bot_skills_for(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.bot_skills_for(uuid, text, text, text) to service_role;

-- -------------------------------------------- the super admin's page --
create or replace function public._is_super_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and auth.uid() = (select super_admin from public.brain_settings where id = 1)
$$;
revoke all on function public._is_super_admin() from public, anon, authenticated;

create or replace function public.bot_permissions()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public._is_super_admin() then raise exception 'Only the super admin sees permissions'; end if;
  return jsonb_build_object(
    'skills', coalesce((select jsonb_agg(to_jsonb(s) order by s.sort) from public.bot_skill s), '[]'::jsonb),
    'defaults', coalesce((select jsonb_agg(to_jsonb(d)) from public.bot_default d), '[]'::jsonb),
    'grants', coalesce((
      select jsonb_agg(to_jsonb(g) || jsonb_build_object('name', coalesce(nullif(p.display_name, ''), p.username)) order by g.updated_at desc)
        from public.bot_grant g left join public.profile p on p.id = g.user_id
    ), '[]'::jsonb),
    'rules', coalesce((select jsonb_agg(to_jsonb(r) order by r.kind) from public.bot_kind_rules r), '[]'::jsonb),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', coalesce(nullif(p.display_name, ''), p.username), 'role', p.role)
                       order by coalesce(nullif(p.display_name, ''), p.username))
        from public.profile p where p.is_active
    ), '[]'::jsonb),
    'super_admin', (select super_admin from public.brain_settings where id = 1)
  );
end $$;
revoke all on function public.bot_permissions() from public, anon;
grant execute on function public.bot_permissions() to authenticated;

-- One change: {op: 'grant', user_id | phone, skill, allowed, chats?, note?}, {op: 'reset', user_id | phone, skill?},
-- {op: 'default', kind, skill, allowed}, {op: 'rules', kind, enabled?, instructions?}.
create or replace function public.bot_permissions_set(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public._is_super_admin() then raise exception 'Only the super admin changes permissions'; end if;
  perform public._bot_permissions_apply(p);
end $$;
revoke all on function public.bot_permissions_set(jsonb) from public, anon;
grant execute on function public.bot_permissions_set(jsonb) to authenticated;

-- The change itself: for bot_permissions_set (the page) and the bot (service role, the super admin's own run).
create or replace function public._bot_permissions_apply(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_op text := p->>'op';
  v_user uuid := nullif(p->>'user_id', '')::uuid;
  v_phone text := nullif(regexp_replace(coalesce(p->>'phone', ''), '\D', '', 'g'), '');
  v_skill text := nullif(p->>'skill', '');
  v_kind text := p->>'kind';
  v_chats text[];
begin
  if v_phone ~ '^0[0-9]{10}$' then v_phone := '2' || v_phone; end if;
  if v_skill is not null and not exists (select 1 from public.bot_skill where key = v_skill and grantable) then
    raise exception 'No such skill to give: %', v_skill;
  end if;
  if v_op in ('grant', 'reset') then
    if (v_user is null) = (v_phone is null) then raise exception 'Who: an account or a number'; end if;
    if v_user is not null and v_user = (select super_admin from public.brain_settings where id = 1) then
      raise exception 'The super admin has everything already';
    end if;
  end if;
  if v_op = 'grant' then
    if v_skill is null or p->'allowed' is null then raise exception 'A grant needs a skill and allowed'; end if;
    if jsonb_typeof(p->'chats') = 'array' then
      select array_agg(x) into v_chats from jsonb_array_elements_text(p->'chats') x where x = 'private' or x ~ '@g\.us$';
    end if;
    delete from public.bot_grant where coalesce(user_id::text, phone) = coalesce(v_user::text, v_phone) and skill = v_skill;
    insert into public.bot_grant (user_id, phone, skill, allowed, chats, note)
    values (v_user, v_phone, v_skill, (p->>'allowed')::boolean, v_chats, nullif(p->>'note', ''));
  elsif v_op = 'reset' then
    delete from public.bot_grant
     where coalesce(user_id::text, phone) = coalesce(v_user::text, v_phone) and (v_skill is null or skill = v_skill);
  elsif v_op = 'default' then
    if v_kind not in ('admin', 'member', 'client') or v_skill is null or p->'allowed' is null then raise exception 'A default needs a kind, a skill and allowed'; end if;
    insert into public.bot_default (kind, skill, allowed) values (v_kind, v_skill, (p->>'allowed')::boolean)
    on conflict (kind, skill) do update set allowed = excluded.allowed;
  elsif v_op = 'rules' then
    if v_kind not in ('admin', 'member', 'client') then raise exception 'Rules need a kind'; end if;
    update public.bot_kind_rules set
      enabled = coalesce((p->>'enabled')::boolean, enabled),
      instructions = case when p ? 'instructions' then left(coalesce(p->>'instructions', ''), 4000) else instructions end,
      updated_at = now()
     where kind = v_kind;
  else
    raise exception 'Unknown change: %', v_op;
  end if;
end $$;
revoke all on function public._bot_permissions_apply(jsonb) from public, anon, authenticated;
grant execute on function public._bot_permissions_apply(jsonb) to service_role;

notify pgrst, 'reload schema';
