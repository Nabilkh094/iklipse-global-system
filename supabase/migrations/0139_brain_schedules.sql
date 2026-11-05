-- 0139_brain_schedules.sql
--   Scheduled tasks (whatsapp-bot schedules.ts): "every Sunday at 10, do X".
--   Each time, the brain does it as if its owner had just asked privately, with
--   their permissions then. Who may set them: the schedule permission (0137):
--   admins by default, as reminders.

create table if not exists public.brain_schedule (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profile(id) on delete cascade,
  text       text not null check (length(text) between 1 and 2000),
  every      text not null check (every in ('once', 'day', 'weekdays', 'week', 'month')),
  days       int[] not null default '{}',
  at         text not null check (at ~ '^\d{2}:\d{2}$'),
  on_date    date,
  zone       text not null default 'Africa/Cairo',
  enabled    boolean not null default true,
  next_at    timestamptz,
  last_at    timestamptz,
  runs       int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists brain_schedule_due_idx on public.brain_schedule (next_at) where enabled;
create index if not exists brain_schedule_user_idx on public.brain_schedule (user_id);
alter table public.brain_schedule enable row level security;
revoke all on public.brain_schedule from anon, authenticated;

insert into public.bot_skill (key, name, about, area, grantable, sort)
values ('schedule', 'Scheduled tasks', 'Have the bot do something on a schedule (every day, every Sunday at 10...).', 'do', true, 48)
on conflict (key) do nothing;
insert into public.bot_default (kind, skill, allowed) values ('admin', 'schedule', true), ('member', 'schedule', false), ('client', 'schedule', false)
on conflict do nothing;

notify pgrst, 'reload schema';
