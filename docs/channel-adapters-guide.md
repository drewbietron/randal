# Channel Adapters Guide

Randal communicates with users through **channels** — adapters that bridge
messaging platforms to the gateway. This guide covers supported channels,
the HTTP API, and how to build your own custom channel.

---

## Supported Channels

| Channel | Status | Guide |
|---------|--------|-------|
| **HTTP** | ✅ Built-in (always active) | [Below](#-http-api) |
| **Discord** | ✅ First-class support | [Discord Guide](./discord-guide.md) |

Channels are configured under `gateway.channels` in your config:

```yaml
gateway:
  channels:
    - type: http
      port: 7600
      auth: "${RANDAL_API_TOKEN}"
    - type: discord
      token: "${DISCORD_BOT_TOKEN}"
      allowFrom: ["123456789012345678"]
```

---

## 🌐 HTTP API

The HTTP channel is always available and provides a REST API + SSE event
streaming. It powers the web dashboard and serves as the programmatic
interface for all integrations.

```yaml
gateway:
  channels:
    - type: http
      port: 7600
      auth: "${RANDAL_API_TOKEN}"
      corsOrigin: "https://yourdomain.com"   # optional
```

### Key Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/job` | Submit a new job |
| `GET` | `/job/:id` | Get job status |
| `DELETE` | `/job/:id` | Stop a job |
| `GET` | `/events` | SSE event stream |
| `GET` | `/health` | Health check |
| `GET` | `/` | Web dashboard |

Authenticated API routes require `Authorization: Bearer <token>` or `?token=<token>`.
Only `/`, `/health`, and `/assets/*` are intentionally public. Internal routes
under `/_internal/*` are not public and require the normal HTTP auth token.
If `gateway.channels[http].auth` is unset, protected routes fail closed with a
configuration error instead of silently becoming public.

### Security

- **Always set `auth`** to a strong, random token
- Use `corsOrigin` to restrict browser-based access to specific domains
- In production, put the HTTP channel behind a reverse proxy (nginx, Caddy)
  with TLS

---

## 💬 Discord

Discord is Randal's primary messaging channel with full-featured support:

- **Conversations**: Threaded conversations with multi-turn context
- **Slash commands**: 7 built-in commands (`/run`, `/status`, `/jobs`, `/stop`, `/resume`, `/memory`, `/dashboard`)
- **Interactive buttons**: Stop, Inject Context, Details, Retry, Resume, Save to Memory
- **Progress tracking**: Edit-in-place status messages with plan checklists
- **Per-server config**: Custom commands, agent/model overrides, server-specific instructions
- **Conversation recovery**: Survives gateway restarts via Meilisearch persistence

👉 **Full setup and reference: [Discord Integration Guide](./discord-guide.md)**

Quick config:

```yaml
gateway:
  channels:
    - type: discord
      token: "${DISCORD_BOT_TOKEN}"
      allowFrom: ["123456789012345678"]
```

---

## 🧩 Community Channels

The gateway codebase includes adapter implementations for additional platforms.
These are functional and tested but **not officially supported** — they are not
wired into the gateway startup loop and may need additional work for production use.

| Channel | Source | Notes |
|---------|--------|-------|
| iMessage | `packages/gateway/src/channels/imessage.ts` | macOS-only, via BlueBubbles |
| Telegram | `packages/gateway/src/channels/telegram.ts` | Via Telegraf library |
| Slack | `packages/gateway/src/channels/slack.ts` | Via Bolt (Socket Mode) |
| Email | `packages/gateway/src/channels/email.ts` | IMAP + SMTP |
| WhatsApp | `packages/gateway/src/channels/whatsapp.ts` | Via Twilio |
| Signal | `packages/gateway/src/channels/signal.ts` | Via signal-cli |
| Voice | `packages/gateway/src/channels/voice.ts` | STT/TTS session bridge |

To enable a community channel, you'll need to wire it into the gateway's channel
startup loop in `packages/gateway/src/gateway.ts`. See [Creating a Custom Channel](#-creating-a-custom-channel)
for the adapter interface.

---

## 🛠️ Creating a Custom Channel

The channel adapter interface is intentionally simple. You can create a custom
channel to bridge any messaging platform to Randal.

### The ChannelAdapter Interface

```typescript
interface ChannelAdapter {
  readonly name: string;           // Unique identifier (e.g., "my-channel")
  start(): Promise<void>;          // Initialize connection, register handlers
  stop(): void;                    // Clean shutdown
  recoverJob?(jobId: string, channelId: string): Promise<void>;  // Optional: restore job mappings after restart
  send?(target: string, message: string): Promise<void>;         // Optional: programmatic message sending
}
```

### Dependencies Injected via ChannelDeps

```typescript
interface ChannelDeps {
  config: RandalConfig;           // Full Randal configuration
  runner: Runner;                 // Submit and manage jobs
  eventBus: EventBus;            // Subscribe to job events
  memoryManager?: MemoryManager; // Optional: search/store memory
  messageManager?: MessageManager; // Optional: persist conversation history
  scheduler?: Scheduler;          // Optional: access scheduling
  skillManager?: SkillManager;   // Optional: skill management
  onUpdate?: () => Promise<string>; // Optional: trigger self-update
}
```

### Shared Utilities

Two shared functions handle the common patterns:

**`handleCommand(text, deps, origin)`** — Parses prefix commands (`run:`, `status`, `stop`, etc.) and executes them against the runner. Returns a response string. All channels use this for consistent command handling.

**`formatEvent(event)`** — Converts a `RunnerEvent` into human-readable text suitable for any chat platform.

### Implementation Pattern

Every channel adapter follows the same pattern:

1. **Inbound**: Receive a platform-specific message → call `handleCommand(text, deps, origin)` → send the response string back via the platform API
2. **Outbound**: Subscribe to `deps.eventBus` → filter events where `job.origin.channel === this.name` → call `formatEvent(event)` → send via platform API
3. **Origin tracking**: Attach `{ channel: "my-channel", replyTo: "thread-123", from: "user-456" }` to every submitted job so events route back to the right place

### Minimal Example

```typescript
import { handleCommand, formatEvent } from "./channel.js";
import type { ChannelAdapter, ChannelDeps } from "./channel.js";

export class MyChannel implements ChannelAdapter {
  readonly name = "my-channel";
  private unsubscribe?: () => void;

  constructor(
    private config: MyChannelConfig,
    private deps: ChannelDeps,
  ) {}

  async start(): Promise<void> {
    // 1. Connect to your platform
    this.platform = await connectToPlatform(this.config);

    // 2. Handle inbound messages
    this.platform.onMessage(async (msg) => {
      const origin = {
        channel: "my-channel" as const,
        replyTo: msg.threadId,
        from: msg.userId,
      };
      const response = await handleCommand(msg.text, this.deps, origin);
      await this.platform.send(msg.threadId, response);
    });

    // 3. Subscribe to outbound events
    this.unsubscribe = this.deps.eventBus.subscribe((event) => {
      const job = this.deps.runner.getJob(event.jobId);
      if (job?.origin?.channel !== "my-channel") return;

      const text = formatEvent(event);
      this.platform.send(job.origin.replyTo, text);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.platform?.disconnect();
  }
}
```

### Wiring Into the Gateway

To activate your channel, add it to the startup loop in
`packages/gateway/src/gateway.ts`:

```typescript
} else if (channelConfig.type === "my-channel") {
  const adapter = new MyChannel(channelConfig, channelDeps);
  await adapter.start();
  channelAdapters.push(adapter);
  logger.info("My channel started");
}
```

And add the config schema in `packages/core/src/config.ts`:

```typescript
const myChannelSchema = z.object({
  type: z.literal("my-channel"),
  // ... your config fields
  allowFrom: z.array(z.string()).optional(),
});
```

---

## 🔒 General Security Checklist

- [ ] Store all tokens and secrets in `.env`, never in config files committed
      to version control
- [ ] Set `allowFrom` on every channel in production
- [ ] Use TLS/HTTPS for all external-facing endpoints
- [ ] Rotate credentials periodically
- [ ] Monitor gateway logs for unauthorized access attempts
- [ ] Use `credentials.allow` to restrict which environment variables the
      runner can access
