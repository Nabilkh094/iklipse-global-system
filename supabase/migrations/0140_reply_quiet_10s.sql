-- 0140_reply_quiet_10s.sql
--   The bot answers a private chat 10 seconds after it goes quiet (was a minute).
--   Still changed any time in the bot's settings (reply_quiet_sec, 5 to 600).

update public.watch_settings set reply_quiet_sec = 10 where id = 1;
