-- 0138_master_channel.sql
--   The super admin's master agent driving the bot (whatsapp-bot master.ts):
--   what the bot says to the master group is kept here for the relay to
--   read, never sent on WhatsApp. kind: reply (to a task), approval (an OK to
--   give), notice (anything else for the super admin). The service role only.

create table if not exists public.master_reply (
  seq        bigserial primary key,
  task_id    text,
  kind       text not null check (kind in ('reply', 'approval', 'notice')),
  text       text not null,
  created_at timestamptz not null default now()
);
create index if not exists master_reply_task_idx on public.master_reply (task_id);
alter table public.master_reply enable row level security;
revoke all on public.master_reply from anon, authenticated;

notify pgrst, 'reload schema';
