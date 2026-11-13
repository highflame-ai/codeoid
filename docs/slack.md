# Slack

Talk to codeoid's conductor from a Slack DM, and approve what your sessions ask for from there.

The daemon connects to Slack itself (Socket Mode), so it needs no public URL.
Slack works only with ZeroID sign-in, never in local mode.

## Setting it up

1. Create a Slack app in a workspace you own: <https://api.slack.com/apps> → Create New App → From an app manifest, and paste:

   ```yaml
   display_information:
     name: codeoid
   features:
     bot_user:
       display_name: codeoid
       always_online: true
     app_home:
       messages_tab_enabled: true
       messages_tab_read_only_enabled: false
     slash_commands:
       - command: /codeoid
         description: Sign in, list and switch sessions
         usage_hint: auth <key> | ls | attach <name> | conductor | stop | who
   oauth_config:
     scopes:
       bot:
         - chat:write
         - commands
         - im:history
         - im:read
   settings:
     event_subscriptions:
       bot_events:
         - message.im
     interactivity:
       is_enabled: true
     socket_mode_enabled: true
   ```

2. Install it to the workspace, and copy the **Bot User OAuth Token** (`xoxb-…`).
3. Under Basic Information → App-Level Tokens, create one with the `connections:write` scope, and copy it (`xapp-…`).
4. Find your Slack member ID: your profile → ⋯ → Copy member ID.
5. Add to `~/.codeoid/.env`, then restart the daemon:

   ```bash
   SLACK_APP_TOKEN=xapp-…
   SLACK_BOT_TOKEN=xoxb-…
   SLACK_ALLOWED_USER_IDS=U0123ABCD   # comma-separated
   ```

6. In Slack, run `/codeoid auth <zid_sk_…>` once with your ZeroID key. A slash command isn't posted to the conversation, so the key doesn't stay in it.

`codeoid start --no-slack` starts the daemon without it.

## Using it

- Message the codeoid app to talk to the conductor. It is created the first time you write.
- `/codeoid ls` lists your sessions; `/codeoid attach <name>` talks to one instead; `/codeoid conductor` goes back.
- `/codeoid stop` interrupts the current turn; `/codeoid who` shows who you are signed in as.
- When the session you're talking to asks to run something, a card shows what it would do, the workstream it acts in, its risk and whether it is sandboxed, with Approve and Deny buttons. Only you can press your cards.
- When another of your sessions is waiting on you, you get a message naming it.

Only the people in `SLACK_ALLOWED_USER_IDS` can use it, and each acts with their own key: what they can do is what that key allows.
Your sign-in ends when the key's token expires; run `/codeoid auth` again.
