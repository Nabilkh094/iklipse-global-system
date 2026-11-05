-- 0136_one_super_admin.sql
--   One super admin, and only ever one: brain_settings.super_admin.
--   - owner_users (what the bot and the brain read) is always that one person.
--   - Nobody names a super admin from the app, the bot or the master: the only
--     way is super_admin_hand_over(<their WhatsApp number>), run by the
--     database owner (Supabase SQL editor) or the service role.
--   - The super admin's account is locked: it can't be deleted, turned off or
--     lowered from admin, and their WhatsApp numbers can't be taken off or
--     moved to someone else, except by themselves on the site.
--   The super admin is an admin in the app (profile.role stays 'admin').

alter table public.brain_settings add column if not exists super_admin uuid references public.profile(id) on delete restrict;

-- During a hand-over (and only then) the locks let it through.
create or replace function public._handing_over()
returns boolean language sql stable as $$
  select coalesce(current_setting('iklipse.hand_over', true), '') = 'on'
$$;

create or replace function public._super_admin()
returns uuid language sql stable security definer set search_path = public as $$
  select super_admin from public.brain_settings where id = 1
$$;
revoke all on function public._super_admin() from public, anon, authenticated;

-- brain_settings: super_admin changes only in a hand-over; owner_users follows it.
-- Named to run before owner_guard and owner_phones_sync (triggers run in name order).
create or replace function public._a_one_super_admin()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.super_admin is distinct from old.super_admin and not public._handing_over() then
    raise exception 'The super admin changes only by a hand-over (super_admin_hand_over, in the SQL editor)';
  end if;
  if new.super_admin is not null then
    new.owner_users := array[new.super_admin];
  end if;
  return new;
end $$;
revoke all on function public._a_one_super_admin() from public, anon, authenticated;
drop trigger if exists a_one_super_admin on public.brain_settings;
create trigger a_one_super_admin before update on public.brain_settings
  for each row execute function public._a_one_super_admin();

-- The account: never deleted, turned off or lowered.
create or replace function public._super_admin_account_lock()
returns trigger language plpgsql security definer set search_path = public as $$
declare v uuid := public._super_admin();
begin
  if v is null or public._handing_over() then return coalesce(new, old); end if;
  if tg_op = 'DELETE' and old.id = v then
    raise exception 'The super admin''s account can''t be removed';
  end if;
  if tg_op = 'UPDATE' and old.id = v and (new.role <> 'admin' or not new.is_active) then
    raise exception 'The super admin''s account can''t be turned off or lowered';
  end if;
  return coalesce(new, old);
end $$;
revoke all on function public._super_admin_account_lock() from public, anon, authenticated;
drop trigger if exists super_admin_lock on public.profile;
create trigger super_admin_lock before update or delete on public.profile
  for each row execute function public._super_admin_account_lock();

-- Their linked numbers and ids: only they take them off or move them (on the site, as themselves).
create or replace function public._super_admin_numbers_lock()
returns trigger language plpgsql security definer set search_path = public as $$
declare v uuid := public._super_admin();
begin
  if v is null or public._handing_over() or old.user_id <> v then return coalesce(new, old); end if;
  if auth.uid() is not distinct from v then return coalesce(new, old); end if;
  if tg_op = 'DELETE' or new.user_id <> old.user_id then
    raise exception 'Only the super admin takes their own numbers off';
  end if;
  return new;
end $$;
revoke all on function public._super_admin_numbers_lock() from public, anon, authenticated;
drop trigger if exists super_admin_lock on public.wa_member;
create trigger super_admin_lock before update or delete on public.wa_member
  for each row execute function public._super_admin_numbers_lock();
drop trigger if exists super_admin_lock on public.wa_member_lid;
create trigger super_admin_lock before update or delete on public.wa_member_lid
  for each row execute function public._super_admin_numbers_lock();

-- The number on their card: only they change or clear it.
create or replace function public._super_admin_card_lock()
returns trigger language plpgsql security definer set search_path = public as $$
declare v uuid := public._super_admin();
begin
  if v is null or public._handing_over() or old.user_id <> v then return coalesce(new, old); end if;
  if auth.uid() is not distinct from v then return coalesce(new, old); end if;
  if tg_op = 'DELETE' or new.whatsapp is distinct from old.whatsapp then
    raise exception 'Only the super admin changes their own WhatsApp number';
  end if;
  return new;
end $$;
revoke all on function public._super_admin_card_lock() from public, anon, authenticated;
drop trigger if exists super_admin_lock on public.profile_contact;
create trigger super_admin_lock before update or delete on public.profile_contact
  for each row execute function public._super_admin_card_lock();

-- The hand-over: by the WhatsApp number linked to the person (01xxxxxxxxx or 201xxxxxxxxx).
-- Not for the app: the SQL editor (database owner) or the service role only.
create or replace function public.super_admin_hand_over(p_phone text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_phone text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_users uuid[];
  v_user uuid;
begin
  if v_phone ~ '^0[0-9]{10}$' then v_phone := '2' || v_phone; end if;
  select coalesce(array_agg(distinct u.user_id), '{}') into v_users
    from (
      select m.user_id from public.wa_member m where m.phone = v_phone
      union
      select c.user_id from public.profile_contact c where c.whatsapp = v_phone
    ) u
    join public.profile p on p.id = u.user_id;
  if cardinality(v_users) = 0 then
    raise exception 'No account has the WhatsApp number % (link it on the Users page first)', v_phone;
  end if;
  if cardinality(v_users) > 1 then
    raise exception 'More than one account has the number %', v_phone;
  end if;
  v_user := v_users[1];
  perform set_config('iklipse.hand_over', 'on', true);
  update public.profile set role = 'admin', is_active = true where id = v_user and (role <> 'admin' or not is_active);
  update public.brain_settings set super_admin = v_user where id = 1;
  perform set_config('iklipse.hand_over', '', true);
  return v_user;
end $$;
revoke all on function public.super_admin_hand_over(text) from public, anon, authenticated;
grant execute on function public.super_admin_hand_over(text) to service_role;

-- Settings from the app: everything as before but who the super admin is.
create or replace function public.brain_settings_set(p jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_models text[] := array[
    'claude-haiku-5-5',
    'claude-sonnet-5-5',
    'claude-opus-5-5',
    'claude-fable-5-1',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-opus-4-5-20251101',
    'claude-sonnet-4-5-20250929',
    'claude-haiku-4-5-20251001'
  ];
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if p ? 'owner_users' or p ? 'super_admin' then raise exception 'There is one super admin; it changes only by a hand-over'; end if;
  if p ? 'model_owner' and not (p->>'model_owner' = any(v_models)) then raise exception 'Unknown model'; end if;
  if p ? 'model_member' and not (p->>'model_member' = any(v_models)) then raise exception 'Unknown model'; end if;
  if p ? 'model_fast' and not (p->>'model_fast' = any(v_models)) then raise exception 'Unknown model'; end if;
  update public.brain_settings s set
    phase        = coalesce((p->>'phase')::int, s.phase),
    stopped      = coalesce((p->>'stopped')::boolean, s.stopped),
    stopped_at   = case when p ? 'stopped' and (p->>'stopped')::boolean is distinct from s.stopped
                        then (case when (p->>'stopped')::boolean then now() end) else s.stopped_at end,
    stopped_by   = case when p ? 'stopped' and (p->>'stopped')::boolean is distinct from s.stopped
                        then (case when (p->>'stopped')::boolean then 'Alerts > Brain' end) else s.stopped_by end,
    fallback_old = coalesce((p->>'fallback_old')::boolean, s.fallback_old),
    model_owner  = coalesce(p->>'model_owner', s.model_owner),
    model_member = coalesce(p->>'model_member', s.model_member),
    model_fast   = coalesce(p->>'model_fast', s.model_fast),
    max_turns    = coalesce((p->>'max_turns')::int, s.max_turns),
    member_turns = coalesce((p->>'member_turns')::int, s.member_turns),
    run_minutes  = coalesce((p->>'run_minutes')::int, s.run_minutes),
    run_cost_usd = coalesce((p->>'run_cost_usd')::numeric, s.run_cost_usd),
    day_cost_usd = coalesce((p->>'day_cost_usd')::numeric, s.day_cost_usd),
    updated_at   = now(),
    updated_by   = auth.uid()
  where s.id = 1;
end $$;

-- Who it is for the site (any signed-in user may know who the super admin is).
create or replace function public.super_admin_id()
returns uuid language sql stable security definer set search_path = public as $$
  select super_admin from public.brain_settings where id = 1
$$;
revoke all on function public.super_admin_id() from public, anon;
grant execute on function public.super_admin_id() to authenticated;

-- The first one, for testing: the owner (201150472975). Moved to Nabil later with
--   select public.super_admin_hand_over('201110648177');
-- If that number isn't linked to an account yet, today's first super admin stays it.
do $$
begin
  begin
    perform public.super_admin_hand_over('201150472975');
  exception when others then
    raise notice 'hand-over to 201150472975 skipped: %', sqlerrm;
    perform set_config('iklipse.hand_over', 'on', true);
    update public.brain_settings set super_admin = owner_users[1] where id = 1 and super_admin is null and cardinality(owner_users) > 0;
    perform set_config('iklipse.hand_over', '', true);
  end;
end $$;

notify pgrst, 'reload schema';
