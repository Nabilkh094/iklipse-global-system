-- 0135: Green API is gone. The bot reaches WhatsApp only through its own
-- bridge (WAHA, 0097, whatsapp-bot waha.ts), so there's nothing to choose
-- between (wa_provider) and no Green API connection to set up or read.
--
-- WhatsApp notifications (a member's notification channel, automations, the
-- admin's test, 0037 _send_whatsapp) went straight to Green API; they now go
-- to the bot (whatsapp-bot /notify, signed like the tick), which sends them
-- on its number.
--
-- The vault's greenapi_url, greenapi_instance and greenapi_token are left
-- where they are: nothing reads them any more, and they're deleted apart,
-- once the owner says so.

drop function if exists public.admin_set_greenapi(text, text, text);

-- What the bot reads of the vault: the Slack app, and the app's address.
create or replace function public._watch_config()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  return jsonb_build_object(
    'slack_bot_token', public._secret('slack_bot_token'),
    'slack_signing_secret', public._secret('slack_signing_secret'),
    'app_url', (select rtrim(app_url, '/') from public.workspace limit 1));
end $$;
revoke all on function public._watch_config() from public, anon, authenticated;

-- A WhatsApp message to a member (their number on their member card), sent by the bot.
create or replace function public._send_whatsapp(p_user uuid, p_text text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_to  text;
  v_url text := regexp_replace(coalesce(public._secret('watch_webhook_url'), ''), '/tick/?$', '/notify');
  v_sec text := public._secret('watch_webhook_secret');
  v_req bigint;
begin
  if coalesce(btrim(p_text), '') = '' then return false; end if;
  select c.whatsapp into v_to from public.profile_contact c join public.profile p on p.id = c.user_id
   where c.user_id = p_user and p.is_active;
  if v_to is null then
    insert into public.outbound_message (channel, user_id, status) values ('whatsapp', p_user, 'no_contact');
    return false;
  end if;
  if v_url !~ '/notify$' or v_sec is null then
    insert into public.outbound_message (channel, user_id, status) values ('whatsapp', p_user, 'not_configured');
    return false;
  end if;
  if public._outbox_full() then
    insert into public.outbound_message (channel, user_id, status) values ('whatsapp', p_user, 'limited');
    return false;
  end if;
  v_req := net.http_post(
    url     := v_url,
    body    := jsonb_build_object('to', v_to, 'text', left(p_text, 4000)),
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Iklipse-Secret', v_sec),
    timeout_milliseconds := 30000);
  insert into public.outbound_message (channel, user_id, status, request_id) values ('whatsapp', p_user, 'sent', v_req);
  return true;
end $$;
revoke all on function public._send_whatsapp(uuid, text) from public, anon, authenticated;

-- As 0052, with WhatsApp set up when the bot can send: its number is linked and it's reachable.
create or replace function public.integration_status()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_ws public.workspace; v_sender text;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  select * into v_ws from public.workspace limit 1;
  select email into v_sender from public.gmail_account where id = v_ws.notify_gmail_account;
  return jsonb_build_object(
    'whatsapp', jsonb_build_object(
      'configured', public._secret('watch_webhook_url') is not null and public._secret('watch_webhook_secret') is not null
                    and exists (select 1 from public.watch_settings where id = 1 and bot_phone is not null),
      'phone', (select bot_phone from public.watch_settings where id = 1)),
    'email', jsonb_build_object(
      'configured', (v_sender is not null and public._secret('gmail_webhook_url') is not null and public._secret('gmail_webhook_secret') is not null)
                 or (public._secret('email_webhook_url') is not null and public._secret('email_webhook_secret') is not null),
      'gmail_sender', v_sender,
      'n8n', public._secret('email_webhook_url') is not null and public._secret('email_webhook_secret') is not null),
    'inbox', jsonb_build_object(
      'list_id', v_ws.email_inbox_list_id,
      'list_title', (select title from public.list where id = v_ws.email_inbox_list_id),
      'board_title', (select b.title from public.list l join public.board b on b.id = l.board_id where l.id = v_ws.email_inbox_list_id)),
    'sent_last_hour', (select count(*) from public.outbound_message where created_at > now() - interval '1 hour' and status = 'sent'));
end $$;

-- As 0078, with the bot set up once its number is linked (it has a number), and no Green API instance.
create or replace function public.watch_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.watch_settings; v_admin boolean := public.is_admin();
begin
  if not public.am_active() then raise exception 'Not allowed'; end if;
  select * into s from public.watch_settings where id = 1;
  return jsonb_build_object(
    'is_admin', v_admin,
    'open', (select count(*) from public.watch_alert a where a.status = 'open'
               and (v_admin or exists (select 1 from public.watch_recipient r where r.alert_id = a.id and r.user_id = auth.uid()))),
    'mine', (select count(*) from public.watch_alert a join public.watch_recipient r on r.alert_id = a.id
              where a.status = 'open' and r.user_id = auth.uid()),
    -- Calls reach a phone that's closed only as push notifications.
    'my_push', exists (select 1 from public.push_subscription where user_id = auth.uid()),
    'my_phone', exists (select 1 from public.native_device where user_id = auth.uid()),
    'my_mail', coalesce((
      select jsonb_agg(jsonb_build_object(
               'account_id', g.id, 'email', g.email, 'watching', w.account_id is not null,
               'checked_at', w.checked_at, 'last_error', w.last_error)
               order by g.connected_at)
        from public.gmail_account g
        left join public.mail_watch w on w.account_id = g.id
       where g.user_id = auth.uid()), '[]'::jsonb),
    'settings', case when v_admin then to_jsonb(s) - 'id' - 'tick_lock' - 'bot_state' - 'bot_phone' - 'hook_at' - 'synced_at'
                                       - 'slack_team' - 'slack_team_id' - 'slack_url' - 'slack_bot_user' - 'slack_state'
                                       - 'slack_hook_at' - 'slack_synced_at' end,
    'bot', case when v_admin then jsonb_build_object(
      'configured', s.bot_phone is not null,
      'state', s.bot_state,
      'phone', s.bot_phone,
      'hook_at', s.hook_at,
      'synced_at', s.synced_at,
      'groups', (select count(*) from public.wa_group where left_at is null),
      'monitored', (select count(*) from public.wa_group where left_at is null and monitored)) end,
    'mail', case when v_admin then jsonb_build_object(
      'watched', (select count(*) from public.mail_watch),
      'people', (select count(distinct user_id) from public.mail_watch)) end,
    'slack', case when v_admin then jsonb_build_object(
      'configured', public._secret('slack_bot_token') is not null and public._secret('slack_signing_secret') is not null,
      'team', s.slack_team,
      'url', s.slack_url,
      'state', s.slack_state,
      'hook_at', s.slack_hook_at,
      'synced_at', s.slack_synced_at,
      'channels', (select count(*) from public.slack_channel where left_at is null),
      'monitored', (select count(*) from public.slack_channel where left_at is null and monitored)) end);
end $$;

-- Nothing to choose between.
alter table public.watch_settings drop column if exists wa_provider;
