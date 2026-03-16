# Channel Adapters Setup Guide

Randal communicates with users through **channels** — adapters that bridge
messaging platforms to the gateway. This guide covers setup for each
supported channel.

---

## Overview

Channels are configured under `gateway.channels` in your config. Each channel
has a `type` and platform-specific settings:

```yaml
gateway:
  channels:
    - type: telegram
      token: ${TELEGRAM_BOT_TOKEN}
    - type: slack
      botToken: ${SLACK_BOT_TOKEN}
      appToken: ${SLACK_APP_TOKEN}
```

All channels support an optional `allowFrom` list that restricts who can
interact with Randal. When omitted, all users on that platform can send
messages.

---

## Telegram

### Setup

1. **Create a bot** via [BotFather](https://t.me/BotFather):
   - Send `/newbot` and follow the prompts.
   - Copy the **HTTP API token** BotFather gives you.

2. **Configure bot settings** (optional but recommended):
   - `/setprivacy` → Disable (so the bot sees all group messages, if needed).
   - `/setcommands` → Add commands like `start - Start a conversation`.

3. **Add to `.env`**:

```bash
TELEGRAM_BOT_TOKEN=123456789:ABCdefGhIjKlMnOpQrStUvWxYz
```

4. **Config**:

```yaml
gateway:
  channels:
    - type: telegram
      token: ${TELEGRAM_BOT_TOKEN}
      allowFrom:
        - "123456789"        # Telegram user ID (numeric string)
        - "987654321"
```

### Finding your Telegram user ID

Send a message to [@userinfobot](https://t.me/userinfobot) — it replies with
your numeric user ID.

### Security considerations

- **Always set `allowFrom`** in production. Without it, anyone who finds your
  bot can send it commands.
- The bot token grants full control of the bot. Store it in `.env`, never in
  version control.
- Telegram does not support end-to-end encryption for bot messages. Avoid
  sending sensitive data through the bot.

---

## Slack

### Setup

1. **Create a Slack app** at [api.slack.com/apps](https://api.slack.com/apps):
   - Choose "From scratch" and select your workspace.

2. **Enable Socket Mode**:
   - Under Settings → Socket Mode, toggle it on.
   - Generate an **App-Level Token** with `connections:write` scope. This is
     your `appToken` (starts with `xapp-`).

3. **Add bot scopes** under OAuth & Permissions → Bot Token Scopes:
   - `app_mentions:read`
   - `chat:write`
   - `im:history`
   - `im:read`
   - `im:write`

4. **Enable Events** under Event Subscriptions:
   - Subscribe to: `app_mention`, `message.im`

5. **Install to workspace** and copy the **Bot User OAuth Token** (starts
   with `xoxb-`).

6. **Get the Signing Secret** from Basic Information → App Credentials.

7. **Add to `.env`**:

```bash
SLACK_BOT_TOKEN=xoxb-xxxxxxxxxxxx-xxxxxxxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxx
SLACK_APP_TOKEN=xapp-1-xxxxxxxxxxxx-xxxxxxxxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
SLACK_SIGNING_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

8. **Config**:

```yaml
gateway:
  channels:
    - type: slack
      botToken: ${SLACK_BOT_TOKEN}
      appToken: ${SLACK_APP_TOKEN}
      signingSecret: ${SLACK_SIGNING_SECRET}
      allowFrom:
        - "U01ABCDEF"     # Slack user ID
```

### Finding Slack user IDs

Click on a user's profile → "More" → "Copy member ID".

### Security considerations

- **Socket Mode** is recommended over public HTTP endpoints — it avoids
  exposing a webhook URL.
- The `signingSecret` verifies that incoming events genuinely come from
  Slack. Always set it.
- `allowFrom` uses Slack user IDs, not display names (which can change).
- Bot tokens have broad permissions. Restrict scopes to the minimum needed.

---

## Email

### Setup

Randal connects to an email account via IMAP (to receive) and SMTP (to
send).

1. **Create or use a dedicated email account** for Randal. Avoid using a
   personal account.

2. **Enable IMAP access** in the email provider's settings (Gmail, Outlook,
   etc.).

3. **For Gmail**: Generate an [App Password](https://myaccount.google.com/apppasswords)
   instead of using your regular password.

4. **Add to `.env`**:

```bash
EMAIL_IMAP_HOST=imap.gmail.com
EMAIL_IMAP_USER=randal@yourdomain.com
EMAIL_IMAP_PASS=xxxx-xxxx-xxxx-xxxx
EMAIL_SMTP_HOST=smtp.gmail.com
EMAIL_SMTP_USER=randal@yourdomain.com
EMAIL_SMTP_PASS=xxxx-xxxx-xxxx-xxxx
```

5. **Config**:

```yaml
gateway:
  channels:
    - type: email
      imap:
        host: ${EMAIL_IMAP_HOST}
        port: 993
        user: ${EMAIL_IMAP_USER}
        password: ${EMAIL_IMAP_PASS}
        tls: true
      smtp:
        host: ${EMAIL_SMTP_HOST}
        port: 587
        user: ${EMAIL_SMTP_USER}
        password: ${EMAIL_SMTP_PASS}
        secure: false
      allowFrom:
        - "boss@company.com"
        - "*@company.com"       # wildcard domain
```

### Security considerations

- **Use app passwords** or OAuth tokens, never the account's primary
  password.
- **Use a dedicated email account**. If compromised, it won't expose
  personal email.
- `allowFrom` supports wildcard domain matching (`*@company.com`) to allow
  all addresses from a domain.
- Enable TLS for IMAP and SMTP connections (the defaults do this).
- Email content is not end-to-end encrypted unless you use PGP/S-MIME.

---

## WhatsApp

### Setup (Twilio provider)

Randal supports WhatsApp through the Twilio WhatsApp API.

1. **Set up Twilio WhatsApp** in the
   [Twilio Console](https://console.twilio.com):
   - Navigate to Messaging → Try it Out → Send a WhatsApp Message.
   - For production, apply for a WhatsApp Business Profile.

2. **Note your Twilio WhatsApp number** (e.g. `+14155238886` for the
   sandbox).

3. **Add to `.env`**:

```bash
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_WHATSAPP_NUMBER=+14155238886
```

4. **Config**:

```yaml
gateway:
  channels:
    - type: whatsapp
      provider: twilio
      accountSid: ${TWILIO_ACCOUNT_SID}
      authToken: ${TWILIO_AUTH_TOKEN}
      phoneNumber: ${TWILIO_WHATSAPP_NUMBER}
      allowFrom:
        - "+15551234567"
```

### Security considerations

- Twilio sandbox numbers are for testing only. Apply for a production number
  before going live.
- WhatsApp messages are end-to-end encrypted between the user and Twilio's
  servers, but Twilio (and Randal) can read message content.
- **Always set `allowFrom`** with phone numbers in E.164 format.
- Store `authToken` securely — it grants full API access to your Twilio
  account.

---

## Signal

### Setup

Randal connects to Signal via [signal-cli](https://github.com/AsamK/signal-cli),
a command-line client for the Signal protocol.

1. **Install signal-cli**:

```bash
# macOS
brew install signal-cli

# Linux (manual)
wget https://github.com/AsamK/signal-cli/releases/latest/download/signal-cli-Linux.tar.gz
tar xf signal-cli-Linux.tar.gz
sudo mv signal-cli /usr/local/bin/
```

2. **Register or link a phone number**:

```bash
# Register a new number (requires receiving an SMS)
signal-cli -u +15551234567 register
signal-cli -u +15551234567 verify 123456

# Or link to an existing Signal account
signal-cli link -n "Randal Agent"
```

3. **Verify it works**:

```bash
signal-cli -u +15551234567 receive
```

4. **Config**:

```yaml
gateway:
  channels:
    - type: signal
      phoneNumber: "+15551234567"
      signalCliBin: signal-cli           # default, or full path
      allowFrom:
        - "+15559876543"
```

### Security considerations

- Signal provides **end-to-end encryption** — Randal only sees decrypted
  messages on the local machine.
- The `signal-cli` data directory (`~/.local/share/signal-cli/`) contains
  private keys. Protect it with appropriate file permissions.
- **Registering a number** ties it to signal-cli. You cannot use the same
  number on a phone simultaneously (use "link" instead).
- `allowFrom` uses E.164 phone numbers.
- signal-cli stores messages locally. Ensure disk encryption on the host.

---

## HTTP (built-in)

The HTTP channel is always available and provides a REST API + SSE streaming:

```yaml
gateway:
  channels:
    - type: http
      port: 7600
      auth: ${API_TOKEN}
      corsOrigin: "https://yourdomain.com"   # optional
```

### Security considerations

- **Always set `auth`** to a strong, random token.
- Use `corsOrigin` to restrict browser-based access to specific domains.
- In production, put the HTTP channel behind a reverse proxy (nginx, Caddy)
  with TLS.

---

## Discord

Discord setup is covered in the [deployment guide](./deployment-guide.md).
Quick reference:

```yaml
gateway:
  channels:
    - type: discord
      token: ${DISCORD_BOT_TOKEN}
      allowFrom:
        - "123456789012345678"    # Discord user ID
```

### Security considerations

- Create the bot with minimum required permissions (Send Messages, Read
  Message History).
- Use `allowFrom` with Discord user IDs (not usernames).
- Discord bot tokens grant full bot access. Rotate them if compromised.

---

## iMessage (via BlueBubbles)

iMessage setup is covered in the [deployment guide](./deployment-guide.md).
Quick reference:

```yaml
gateway:
  channels:
    - type: imessage
      provider: bluebubbles
      url: ${BLUEBUBBLES_URL}
      password: ${BLUEBUBBLES_PASSWORD}
      allowFrom:
        - "+15551234567"
        - "user@icloud.com"
```

### Security considerations

- BlueBubbles requires a Mac running at all times.
- The BlueBubbles password secures the API. Use a strong, unique value.
- iMessage is end-to-end encrypted between Apple devices, but BlueBubbles
  exposes decrypted content via its API.
- Restrict `allowFrom` to known phone numbers and iCloud emails.

---

## Multiple channels

You can run as many channels as you need simultaneously:

```yaml
gateway:
  channels:
    - type: http
      port: 7600
      auth: ${API_TOKEN}
    - type: telegram
      token: ${TELEGRAM_BOT_TOKEN}
      allowFrom: ["123456789"]
    - type: slack
      botToken: ${SLACK_BOT_TOKEN}
      appToken: ${SLACK_APP_TOKEN}
    - type: discord
      token: ${DISCORD_BOT_TOKEN}
      allowFrom: ["123456789012345678"]
```

All channels feed into the same gateway event bus. The runner processes jobs
from all channels identically.

---

## General security checklist

- [ ] Store all tokens and secrets in `.env`, never in config files committed
      to version control.
- [ ] Set `allowFrom` on every channel in production.
- [ ] Use TLS/HTTPS for all external-facing endpoints.
- [ ] Rotate credentials periodically.
- [ ] Monitor the gateway logs for unauthorized access attempts.
- [ ] Use the `credentials.allow` config to restrict which environment
      variables the runner can access.
