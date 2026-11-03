# The owner's own Claude on WhatsApp

Claude Code (the unmodified one) on the claude-vps server, signed in with the
owner's own Claude account, reached from one WhatsApp group through the bot's
number. Separate from the bot and the brain: those stay on the API key.

- Only the owner's messages in that group are taken (`OWNERS`). Anyone else in
  the group is ignored: a subscription is for the one who has it.
- The bot stays out of the group: `PERSONAL_GROUP` (a secret of the
  whatsapp-bot function) is the group's id.
- Claude runs as the `claude-me` user (no sudo, nothing of the brain's), in
  `/home/claude-me/work`, without asking before what it does there.
- `/new` starts a new conversation, `/stop` ends the one running.

## Setup (as root on claude-vps)

```bash
useradd -m -s /bin/bash claude-me && mkdir -p /home/claude-me/work && chown -R claude-me: /home/claude-me/work
npm install -g @anthropic-ai/claude-code
install -d -m 0755 /opt/claude-me && install -m 0644 personal/relay.mjs /opt/claude-me/relay.mjs
install -d -m 0700 /etc/claude-me
grep ^WAHA_API_KEY= /opt/waha/.env | cut -d= -f2- > /etc/claude-me/waha.key && chmod 600 /etc/claude-me/waha.key
printf 'GROUP=%s\nOWNERS=%s\n' '<group id>@g.us' '<lid>@lid,<number>@c.us' > /etc/claude-me/relay.conf
install -m 0644 personal/claude-me-relay.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now claude-me-relay
```

The owner signs in themselves (Anthropic's own sign-in; nobody else sees it):

```bash
sudo -iu claude-me claude
```

then `/login`, and `/mcp` to see the claude.ai connectors that came with it.
GitHub: `sudo -iu claude-me gh auth login`. Google Drive: `sudo -iu claude-me rclone config`.

Logs: `journalctl -u claude-me-relay -f`.
