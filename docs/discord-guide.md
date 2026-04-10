# 💬 Discord Integration Guide

Randal's Discord integration is the primary way most users interact with their agent. This guide covers everything from initial bot setup to advanced per-server configuration.

---

## 🤖 Bot Setup

### 1. Create a Discord Application

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application** and give it a name (e.g., "Randal")
3. Navigate to **Bot** in the left sidebar
4. Click **Reset Token** to generate a bot token — **copy it immediately** (you won't see it again)

### 2. Enable Required Intents

Under **Bot → Privileged Gateway Intents**, enable:

- ✅ **Message Content Intent** — Required for reading message text

The bot also uses Guilds, Guild Messages, and Direct Messages intents, which are non-privileged and enabled by default.

### 3. Set Bot Permissions

Navigate to **OAuth2 → URL Generator**:

1. Under **Scopes**, select: `bot`
2. Under **Bot Permissions**, select:
   - Send Messages
   - Read Message History
   - View Channels
   - Create Public Threads *(for conversation threading)*
   - Send Messages in Threads
   - Manage Threads *(for thread renaming on completion)*
3. Copy the generated URL and open it in your browser to invite the bot to your server

### 4. Configure Randal

Add to your `.env`:
```bash
DISCORD_BOT_TOKEN=your-bot-token-here
```

Add to `randal.config.yaml`:
```yaml
gateway:
  channels:
    - type: discord
      token: "${DISCORD_BOT_TOKEN}"
      allowFrom:
        - "123456789012345678"   # Your Discord user ID
```

### Finding Your Discord User ID

1. Open Discord Settings → Advanced → Enable **Developer Mode**
2. Right-click your username → **Copy User ID**

---

## 💬 Conversations

### How Conversations Work

Randal treats Discord as a **conversational** interface, not just a command router:

1. **Guild channels**: When you send a message (or @mention the bot), Randal creates a **thread** for the conversation. All responses stay in that thread.
2. **DMs**: Messages in DMs are tracked as a continuous conversation without threads.
3. **Multi-turn context**: Randal maintains conversation history (last 20 messages) and includes it in each new job, so the agent understands the full context.

### Thread Lifecycle

Threads are automatically named with emoji indicators showing the job state:

| Emoji | State | Example |
|-------|-------|---------|
| 🔄 | Started/Running | `2:15 PM 🔄 Refactor auth module` |
| 🔄 | Running (iteration) | `🔄 [3/10] Refactor auth module` |
| ✅ | Complete | `2:15 PM ✅ Refactor auth module` |
| ❌ | Failed | `2:15 PM ❌ Refactor auth module` |
| ⏸️ | Stopped | `2:15 PM ⏸️ Refactor auth module` |

### Context Injection

If you send a message **while a job is running** in the same thread, Randal automatically injects it as context into the running agent (via `context.md`) instead of starting a new job. You'll see: `*(sent to running agent)*`

This is incredibly useful for steering the agent mid-task:
- "Focus on the tests, skip the README for now"
- "Use Prisma instead of raw SQL"
- "The API endpoint is at /api/v2, not /api/v1"

---

## 🎛️ Slash Commands

Randal registers 7 slash commands automatically:

| Command | Description |
|---------|-------------|
| `/run <prompt>` | Submit a new job |
| `/status [job]` | Check job status (shows rich embed if job ID given) |
| `/jobs` | List recent jobs with status emoji |
| `/stop [job]` | Stop a running job |
| `/resume <job>` | Resume a failed/stopped job |
| `/memory search <query>` | Search agent memory |
| `/memory add` | Add to memory (opens a form) |
| `/dashboard` | System overview with active jobs, recent history, memory stats |

Slash commands register **globally** by default (~1 hour to propagate on first use). To get **instant** registration on a specific server, set `guildId`:

```yaml
gateway:
  channels:
    - type: discord
      token: "${DISCORD_BOT_TOKEN}"
      guildId: "1234567890"   # Your server ID for instant slash commands
```

---

## 🔘 Interactive Buttons

Randal attaches context-appropriate buttons to messages:

### While a Job is Running
- 🛑 **Stop** — Kill the running job
- 💉 **Inject Context** — Opens a modal to send text to the running agent
- 📋 **Details** — Shows a rich embed with job info, iterations, plan progress

### On Job Completion
- 🔄 **Retry** — Re-run the same prompt as a new job
- 💾 **Save to Memory** — Opens a form to save the result to long-term memory

### On Job Failure
- 🔄 **Retry** — Re-run the same prompt
- ▶️ **Resume** — Resume from where it left off (includes prior context)
- 📋 **Details** — View the error and job state

---

## 📊 Progress Tracking

While a job runs, Randal maintains a single **edit-in-place** progress message that updates in real-time:

```
💭 Implementing authentication middleware...

📋 Plan
⬜ Set up Express middleware
⏳ Add JWT validation
⬜ Write integration tests
⬜ Update API docs

🔄 Iteration 2/10
```

The progress message:
- Shows the agent's latest status line
- Displays the plan checklist with status icons (⬜ pending, ⏳ in progress, ✅ done, ❌ failed)
- Shows iteration count for multi-iteration jobs
- Edits are debounced (2 second minimum between edits) to avoid Discord rate limits
- Buttons remain active throughout for Stop, Context Injection, and Details

---

## 🏢 Per-Server Configuration

For bots serving multiple Discord servers, you can customize behavior per guild:

```yaml
gateway:
  channels:
    - type: discord
      token: "${DISCORD_BOT_TOKEN}"
      servers:
        - guildId: "111111111111111111"
          agent: opencode
          model: anthropic/claude-sonnet-4
          instructions: |
            This server is for the frontend team.
            Always use React and TypeScript.
            Follow the project's ESLint config.
          commands:
            - name: review
              description: "Review a PR"
              options:
                - name: url
                  description: "PR URL"
                  type: string
                  required: true
            - name: deploy
              description: "Deploy to staging"
              options:
                - name: environment
                  description: "Target environment"
                  type: string
                  required: true
                  choices: ["staging", "preview"]

        - guildId: "222222222222222222"
          model: anthropic/claude-haiku-4
          instructions: |
            This server is for quick questions only.
            Keep responses brief and conversational.
```

### Server Config Fields

| Field | Type | Description |
|-------|------|-------------|
| `guildId` | string | Discord server ID (required) |
| `agent` | string | Override the default agent for this server |
| `model` | string | Override the default model for this server |
| `instructions` | string | Additional instructions prepended to all prompts from this server |
| `commands` | array | Custom slash commands for this server |

### Custom Slash Commands

Custom commands are registered as **guild commands** (instant, no propagation delay). Each command:
- Has a name, description, and typed options (string, integer, boolean, number)
- Options can have predefined choices
- The command name + option values + server instructions are combined into a prompt
- Uses the server's agent/model overrides if set

---

## 🔐 Access Control

### allowFrom

Restrict who can interact with the bot:

```yaml
gateway:
  channels:
    - type: discord
      token: "${DISCORD_BOT_TOKEN}"
      allowFrom:
        - "123456789012345678"    # User ID 1
        - "987654321098765432"    # User ID 2
```

**Behavior when `allowFrom` is set:**
- Only listed user IDs can trigger jobs
- Messages from other users are silently ignored
- Works in both DMs and guild channels

**Behavior when `allowFrom` is omitted:**
- In DMs: Anyone can message the bot
- In guild channels: The bot only responds when **@mentioned**
- In known threads (threads the bot previously created): Anyone can continue the conversation

### Recommendation

**Always set `allowFrom` in production.** Without it, anyone who can DM your bot or mention it in a server can run agent jobs.

---

## 🔄 Conversation Recovery

Randal persists all Discord conversations to Meilisearch. This means:

- **Gateway restarts**: When the gateway restarts, Randal preloads recent conversations from Meilisearch. If you message in a thread after a restart, the full history is recovered automatically.
- **Job recovery**: If a job was running when the gateway restarted, Randal recovers the job-to-thread mapping and routes completion events back to the correct thread.
- **Cross-restart context**: Conversation history survives gateway restarts, so the agent maintains context even after deployments.

This requires Meilisearch to be configured (recommended for production).

---

## 📢 System Broadcasts

Certain gateway events (like self-updates) are broadcast to all guilds the bot is in. The message is sent to each guild's system channel, or the first text channel the bot can write to.

---

## 🔧 Prefix Commands

In addition to slash commands, you can use prefix commands in any message:

| Command | Example | Description |
|---------|---------|-------------|
| `run: <prompt>` | `run: refactor auth` | Start a new job |
| `status` | `status` | Show all active jobs |
| `status: <id>` | `status: abc1` | Show specific job |
| `stop` | `stop` | Stop most recent job |
| `stop: <id>` | `stop: abc1` | Stop specific job |
| `context: <text>` | `context: focus on tests` | Inject context into running job |
| `jobs` | `jobs` | List all jobs |
| `memory: <query>` | `memory: auth patterns` | Search memory |
| `resume: <id>` | `resume: abc1` | Resume failed job |
| `update` | `update` | Trigger self-update |
| `help` | `help` | Show commands |

**Or just send a message without a prefix** — it's treated as an implicit `run:` command (or context injection if a job is already running in that thread).

---

## 🛡️ Security Checklist

- [ ] Store `DISCORD_BOT_TOKEN` in `.env`, never in version control
- [ ] Set `allowFrom` with Discord user IDs for all production deployments
- [ ] Use minimum required bot permissions (Send Messages, Read Message History, View Channels)
- [ ] Enable only **Message Content Intent** — no other privileged intents needed
- [ ] Rotate the bot token if it's ever exposed
- [ ] For multi-server bots: use per-server configs to scope behavior appropriately

---

## ⚠️ Troubleshooting

### "Disallowed intents" error on startup

The **Message Content Intent** is not enabled. Go to Discord Developer Portal → Your App → Bot → Privileged Gateway Intents → Enable **Message Content Intent**.

Randal will print detailed instructions in the console when this error occurs.

### Slash commands not appearing

- **Global commands** take up to 1 hour to propagate on first registration
- Set `guildId` in your config for instant guild-specific registration
- Verify the bot has been re-invited with the correct scopes after adding slash command support

### Bot not responding in guild channels

If `allowFrom` is not set, the bot only responds when @mentioned in guild channels. Either:
- Set `allowFrom` to always respond to specific users, OR
- @mention the bot in your message

### Messages being ignored

Check that:
1. The user's Discord ID is in `allowFrom` (if set)
2. The bot has View Channels permission for the channel
3. The Message Content Intent is enabled
4. The bot is online (`randal serve` is running)

### Thread name not updating

Discord rate-limits thread name changes to ~2 per 10 minutes. If you're running many jobs quickly, thread names may lag behind the actual job state.
