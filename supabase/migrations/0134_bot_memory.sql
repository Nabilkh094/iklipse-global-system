-- 0134: the bot remembers and finds more (whatsapp-bot timeline.ts, notes.ts
--   dayNotes, search.ts).
--   - The team's hidden-number ids (wa_member_lid) learned from the groups:
--     WhatsApp gives a group's people with their number and their id, and the
--     number is the one linked to them in Alerts > Groups (wa_member). A link
--     already made is never changed. Mentions of them are them.
--   - bot_day_note: what happened in a chat on a day, written by Claude at
--     night, kept and searched like what was said.
--   - bot_search takes the words to look for (p_terms: the asker's words and
--     other ways to say them, Arabic with and without its prefixes), each as
--     the start of a word ("فيديو" finds "فيديوهات"). Without them it's as
--     0117 made it.

insert into public.wa_member_lid (lid, user_id)
select distinct on (p.lid) p.lid, m.user_id
  from public.wa_participant p
  join public.wa_member m on m.phone = p.phone
 where p.lid ~ '^[0-9]{6,20}@lid$' and p.phone is not null
 order by p.lid
on conflict (lid) do nothing;

-- ------------------------------------------------------------ day notes --
create table if not exists public.bot_day_note (
  id       text primary key,              -- "<chat_id>:<day>"
  chat_id  text not null,
  day      date not null,                 -- Cairo day
  place    text not null,                 -- the group's name, or "the private chat with <name>"
  said     int not null default 0,        -- how many messages it sums up
  text     text not null,
  made_at  timestamptz not null default now()
);
create index if not exists bot_day_note_chat_idx on public.bot_day_note (chat_id, day desc);
create index if not exists bot_day_note_day_idx on public.bot_day_note (day desc);
alter table public.bot_day_note enable row level security;
revoke all on public.bot_day_note from anon, authenticated;

alter table public.bot_search_chunk drop constraint if exists bot_search_chunk_source_check;
alter table public.bot_search_chunk add constraint bot_search_chunk_source_check
  check (source in ('wa_message', 'wa_dm', 'mail_message', 'slack_message', 'wa_file', 'fireflies', 'bot_day_note'));

drop trigger if exists search_queue on public.bot_day_note;
create trigger search_queue after insert or update of text or delete on public.bot_day_note for each row execute function public._search_enqueue();

-- ------------------------------------------------------------ searching --
drop function if exists public.bot_search(text, text, text, text[], jsonb, timestamptz, int);

create or replace function public.bot_search(
  p_query     text,
  p_embedding text,            -- the query's embedding ("[0.1, ...]"), or null: keywords only
  p_model     text,
  p_sources   text[],
  p_scope     jsonb,
  p_since     timestamptz default null,
  p_limit     int default 12,
  p_terms     text[] default null  -- the words to look for, each as a word's start; null: p_query's words
)
returns table (id bigint, source text, source_id text, part int, at timestamptz, chat_id text, account_id text, meeting_id text, place text, who text, text text, score float8)
language sql stable security definer set search_path = public, extensions as $$
  with scope as (
    select coalesce((p_scope->>'admin')::boolean, false) as admin,
           array(select jsonb_array_elements_text(coalesce(p_scope->'dms', '[]'))) as dms,
           array(select jsonb_array_elements_text(coalesce(p_scope->'mail', '[]'))) as mail,
           array(select jsonb_array_elements_text(coalesce(p_scope->'ff_accounts', '[]'))) as ff_accounts,
           array(select jsonb_array_elements_text(coalesce(p_scope->'ff_meetings', '[]'))) as ff_meetings
  ),
  -- Who may read what, before anything is ranked (find's rules, look.ts; a private Slack channel: admins only;
  -- a day note of a private chat: as that chat).
  readable as (
    select c.* from public.bot_search_chunk c, scope s
     where c.source = any(p_sources)
       and (p_since is null or c.at >= p_since)
       and case c.source
             when 'wa_dm' then s.admin or c.chat_id = any(s.dms)
             when 'wa_file' then s.admin or c.chat_id like '%@g.us' or c.chat_id = any(s.dms)
             when 'mail_message' then c.account_id = any(s.mail)
             when 'fireflies' then c.account_id = any(s.ff_accounts) or c.meeting_id = any(s.ff_meetings)
             when 'slack_message' then s.admin or not exists (select 1 from public.slack_channel sc where sc.channel_id = c.chat_id and sc.is_private)
             when 'bot_day_note' then s.admin or c.chat_id like '%@g.us' or c.chat_id = any(s.dms)
             else true
           end
  ),
  terms as (
    select distinct regexp_replace(public._search_norm(t), '[^[:alnum:]]', '', 'g') as t
      from unnest(coalesce(p_terms, '{}'::text[])) t
  ),
  q as (
    select coalesce(
      (select to_tsquery('simple', string_agg(t || ':*', ' | ')) from terms where length(t) >= 2),
      nullif(replace(websearch_to_tsquery('simple', public._search_norm(p_query))::text, ' & ', ' | '), '')::tsquery
    ) as ts
  ),
  by_words as (
    select r.id, row_number() over (order by ts_rank(r.tsv, q.ts) desc, r.at desc nulls last) as rank
      from readable r, q
     where q.ts is not null and r.tsv @@ q.ts
     order by rank
     limit 50
  ),
  by_meaning as (
    select r.id, row_number() over (order by r.embedding <=> p_embedding::extensions.vector) as rank
      from readable r
     where p_embedding is not null and r.embedding is not null and r.model = p_model
     order by rank
     limit 50
  ),
  fused as (
    select x.id, sum(1.0 / (60 + x.rank)) as score
      from (select * from by_words union all select * from by_meaning) x
     group by x.id
  )
  select c.id, c.source, c.source_id, c.part, c.at, c.chat_id, c.account_id, c.meeting_id, c.place, c.who, c.text, f.score::float8
    from fused f join public.bot_search_chunk c on c.id = f.id
   order by f.score desc, c.at desc nulls last
   limit greatest(1, least(coalesce(p_limit, 12), 30));
$$;
revoke all on function public.bot_search(text, text, text, text[], jsonb, timestamptz, int, text[]) from public, anon, authenticated;

notify pgrst, 'reload schema';
