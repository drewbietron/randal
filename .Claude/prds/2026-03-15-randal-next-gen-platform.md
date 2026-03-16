# PRD: Randal Next-Gen Platform — Voice, Video, Multi-Instance Mesh, Self-Learning Analytics

## Goal

Transform Randal from an autonomous coding agent harness into a full-spectrum AI teammate platform with real-time voice/video participation (phone calls, Zoom), distributed multi-instance orchestration with analytics-driven scaling, self-learning via human annotation feedback loops, real-time agent callbacks via streaming and MCP, and expanded channel support — making Randal indistinguishable from a human colleague at the interface level.

---

## Scope

### In Scope

1. **Real-time agent callbacks** — Stream agent output line-by-line, implement `parseToolUse()` on adapters, add MCP server integration for bidirectional agent communication
2. **Voice as a first-class primitive** — Inbound/outbound phone calls via LiveKit + Twilio SIP, browser-based voice via WebRTC, voice channel adapter
3. **Video call participation** — Join video calls (Zoom, Meet, Teams) as a full participant via LiveKit, process screen shares via vision models, publish own video/screen share tracks
4. **Multi-instance mesh orchestration** — Instance discovery/registry, health monitoring, workload routing, task delegation across machines, capacity-aware distribution
5. **Self-learning annotation system** — Human verdict collection (pass/fail/partial), analytics engine with reliability scoring, feedback-driven prompt tuning, model selection optimization, routing advisor
6. **Analytics dashboard** — Real-time reliability metrics, per-agent/per-model/per-domain success rates, cost tracking, trend analysis, split recommendations
7. **Expanded channel support** — Telegram, Slack, WhatsApp, Signal, Email (IMAP/SMTP) channel adapters
8. **Browser automation** — Chrome/Chromium control via Chrome DevTools Protocol (CDP) for web browsing, OAuth flows, web scraping
9. **Context compaction** — LLM-based summarization when context grows too large, replacing simple truncation
10. **Comprehensive testing** — Unit tests for every new module, integration tests for cross-package flows, E2E tests for full scenarios, CI pipeline with test gates
11. **Documentation** — Updated README, architecture docs, config reference, voice/video guide, multi-instance guide, analytics guide, channel adapter guide

### Out of Scope

- Mobile companion apps (iOS, Android, macOS native) — future phase
- RL/fine-tuning infrastructure (Hermes-style trajectory collection) — different audience
- Custom LLM hosting/serving — Randal wraps existing agent CLIs
- Payment/billing system for multi-tenant SaaS
- GUI desktop app (Electron/Tauri) — future phase
- Physical robotics integration — future phase

---

## Tech Stack & Constraints

### Existing Stack (Preserved)
| Layer | Technology |
|-------|-----------|
| Runtime | Bun >= 1.1 |
| Language | TypeScript (strict) |
| HTTP Server | Hono |
| Config Validation | Zod |
| Config Format | YAML |
| Search/Memory | Meilisearch |
| File Watching | chokidar |
| Chat | discord.js (Discord), BlueBubbles REST (iMessage) |
| Markdown Parsing | gray-matter |
| CLI Prompts | @clack/prompts |
| Linting | Biome |
| Testing | Bun test |
| Container | Docker (oven/bun:1) |

### New Dependencies
| Dependency | Purpose | License |
|-----------|---------|---------|
| `livekit-server-sdk-js` | LiveKit server SDK for room/token management | Apache-2.0 |
| `@livekit/agents` | LiveKit Agents framework (Node.js/TS) | Apache-2.0 |
| `@livekit/rtc-node` | LiveKit WebRTC client for Node.js | Apache-2.0 |
| `twilio` | Twilio REST API for phone number management, outbound calls | MIT |
| `playwright` or `puppeteer-core` | Chrome DevTools Protocol for browser automation | Apache-2.0 / Apache-2.0 |
| `telegraf` | Telegram Bot API | MIT |
| `@slack/bolt` | Slack app framework | MIT |
| `baileys` | WhatsApp Web API (unofficial) | GPL-3.0 (evaluate licensing) |
| `signal-cli` (via subprocess) | Signal messaging | GPL-3.0 (subprocess, not linked) |
| `nodemailer` + `imapflow` | Email SMTP/IMAP | MIT |
| `@modelcontextprotocol/sdk` | MCP server/client SDK | MIT |

### Constraints
- C1: All new packages must follow existing monorepo conventions (`packages/<name>/`, TypeScript, no build step, Bun-native)
- C2: All new config fields must extend the existing Zod schema in `packages/core/src/config.ts` with sensible defaults that maintain backward compatibility — existing configs must parse without changes
- C3: All new channel adapters must implement the existing `ChannelAdapter` interface from `packages/gateway/src/channels/channel.ts` and use the shared `handleCommand()` + `formatEvent()` functions
- C4: Voice/video features must be opt-in via config — Randal must remain functional without LiveKit/Twilio credentials
- C5: Multi-instance mesh must work with the existing Meilisearch infrastructure — no new database dependencies
- C6: Test coverage for all new code must include unit tests (every exported function), integration tests (cross-package interactions), and E2E tests (full scenarios)
- C7: All new event types must extend the existing `RunnerEventType` union in `packages/core/src/types.ts`
- C8: The self-learning system must not require any external ML infrastructure — it operates on structured data (annotations, job history) with statistical analysis, not model training
- C9: LiveKit can run self-hosted (Apache 2.0) or via LiveKit Cloud — both must be supported via config
- C10: Browser automation must work headless in Docker environments
- C11: Maintain the meta-framework philosophy — Randal wraps agent CLIs, not replaces them. New capabilities extend the harness, not the agent runtime

---

## Requirements

### R1: Real-Time Agent Streaming & Callbacks

- R1.1: Replace batch `readStream()` in `packages/runner/src/runner.ts` with a line-by-line streaming reader that processes stdout incrementally as the agent process runs
- R1.2: Implement `parseToolUse(line)` on the `claude-code` adapter that parses Claude Code's tool use output format (tool name, arguments, result) from individual lines
- R1.3: Implement `parseToolUse(line)` on the `opencode` adapter that parses OpenCode's tool use output format from individual lines
- R1.4: Emit `iteration.tool_use` events in real-time as tool use lines are detected during agent execution, not after process exit
- R1.5: Add a new `iteration.output` event type that streams raw agent output lines to subscribers (rate-limited to max 10 events/second to prevent flooding)
- R1.6: Create an MCP server module (`packages/runner/src/mcp-server.ts`) that implements the Model Context Protocol server specification, exposing Randal tools (memory search, context injection, job status, skill lookup, annotation submission) as MCP tools
- R1.7: Update agent adapters to optionally pass MCP server connection details to the agent CLI (Claude Code supports `--mcp-server` flag; OpenCode supports MCP config)
- R1.8: The MCP server must support concurrent connections from multiple agent processes (one per active job)
- R1.9: Add config field `runner.mcpServer` with sub-fields `enabled` (boolean, default `false`), `port` (number, default `7601`), and `tools` (array of tool names to expose, default `["memory_search", "context", "status", "skills", "annotate"]`)

### R2: Voice Channel — LiveKit + Twilio Integration

- R2.1: Create a new package `packages/voice/` that encapsulates all voice/video functionality, exporting a `VoiceEngine` class
- R2.2: `VoiceEngine` must manage LiveKit room connections, STT/TTS pipeline configuration, and Twilio SIP trunk integration
- R2.3: Implement a `VoiceChannel` class in `packages/gateway/src/channels/voice.ts` that implements `ChannelAdapter` and bridges voice sessions to the existing job submission flow
- R2.4: Support inbound phone calls: Twilio number receives call -> SIP trunk to LiveKit -> STT converts speech to text -> text submitted as job prompt -> agent response converted via TTS -> played back to caller
- R2.5: Support outbound phone calls as an agent tool: agent outputs `<call to="+1..." reason="...">script</call>` structured tag -> runner parses tag -> initiates Twilio outbound call via LiveKit -> agent has real-time voice conversation -> transcript returned as iteration context
- R2.6: Support browser-based voice via WebRTC: dashboard exposes a "Talk" button -> connects to LiveKit room -> same STT/LLM/TTS pipeline as phone calls
- R2.7: STT provider must be configurable: Deepgram (default), OpenAI Whisper, or AssemblyAI
- R2.8: TTS provider must be configurable: ElevenLabs (default), Cartesia, OpenAI TTS, or Edge TTS (free)
- R2.9: Implement turn detection with barge-in support (user can interrupt agent mid-speech)
- R2.10: Add voice-specific config section to Zod schema: `voice: { enabled, livekit: { url, apiKey, apiSecret }, twilio: { accountSid, authToken, phoneNumber }, stt: { provider, model, apiKey }, tts: { provider, voice, apiKey }, turnDetection: { mode: "auto"|"manual" } }`
- R2.11: Voice sessions must maintain conversation history within a session and support multi-turn dialogue
- R2.12: Implement a `call` structured tag parser in `packages/runner/src/call-parser.ts` that extracts outbound call requests from agent output, with Zod-validated schema: `{ to: string, reason?: string, script?: string, maxDuration?: number }`
- R2.13: Track voice usage metrics: call duration, STT/TTS costs, per-session token count
- R2.14: Voice sessions must respect `allowFrom` filters — configurable allowed phone numbers / caller IDs

### R3: Video Call Participation

- R3.1: Extend `VoiceEngine` to support video rooms — agents can join LiveKit rooms as full video+audio participants
- R3.2: Implement screen share reception: agent receives video tracks from other participants, samples frames (1 frame/sec during speech, 1 frame/3sec otherwise), encodes to JPEG, feeds to vision-capable LLM
- R3.3: Implement screen share publishing: agent can publish its own screen (or a designated window/application) as a video track to the LiveKit room, using screenshots from `steer` or headless browser captures
- R3.4: Add SIP dial-in support for joining external video platforms: Randal dials into a Zoom/Meet/Teams meeting via SIP URI, joins as a participant
- R3.5: Implement a `join_call` structured tag parser: agent outputs `<join_call platform="zoom" meeting_id="..." passcode="..."/>` -> runner parses -> VoiceEngine joins the call
- R3.6: Vision frames must be processed through configurable vision models: GPT-4o (default), Gemini Pro Vision, Claude with vision
- R3.7: Video sessions must be recordable (opt-in via config) — audio + video saved to configured path for review
- R3.8: Add config fields: `voice.video: { enabled, visionModel, publishScreen, recordSessions, recordPath }`

### R4: Multi-Instance Mesh Orchestration

- R4.1: Create a new package `packages/mesh/` that handles instance discovery, health monitoring, and workload routing
- R4.2: Implement instance registry in Meilisearch: each Randal instance registers on boot with `{ instanceId, name, posse, capabilities, specialization, status, lastHeartbeat, endpoint, models, activeJobs, completedJobs, health }` — updates every 60 seconds
- R4.3: Implement instance discovery: any instance can query the registry to find all peers in the same posse, filter by capability/specialization/availability
- R4.4: Implement health monitoring: instances ping each other via HTTP `/health` endpoint every 60 seconds; mark instances as `unhealthy` after 3 missed pings; auto-deregister after 10 minutes of no heartbeat
- R4.5: Implement workload routing: when a job is submitted, the mesh evaluates all available instances and routes to the best fit based on: specialization match (weighted 0.4), reliability score from annotations (weighted 0.3), current load / queue depth (weighted 0.2), model availability (weighted 0.1)
- R4.6: Add a `route` structured tag: agent outputs `<route instance="backend-agent" reason="database migration">task description</route>` -> mesh routes to named instance
- R4.7: Implement cross-instance job delegation: instance A can submit a job to instance B via HTTP `POST /job` with `origin.channel = "mesh"` and `origin.from = instanceA.name`
- R4.8: Job results from cross-instance delegation must flow back to the originating instance and be injected as delegation results in the parent job
- R4.9: Add CLI command `randal mesh status` that shows all instances in the posse with health, load, specialization, and reliability scores
- R4.10: Add CLI command `randal mesh route <prompt>` that dry-runs the routing algorithm and shows which instance would handle the task and why
- R4.11: Add config fields: `mesh: { enabled, specialization, endpoint, routingWeights: { specialization, reliability, load, modelMatch } }`
- R4.12: The mesh must be resilient to partial failures — if an instance goes down mid-job, the originating instance must detect the failure (via health check) and either retry on another instance or report the failure
- R4.13: Implement job migration: a running job can be paused on one instance and resumed on another, with full iteration history, plan state, and context transferred via the shared Meilisearch index

### R5: Self-Learning Annotation System

- R5.1: Create a new package `packages/analytics/` that handles annotation collection, analysis, scoring, and recommendations
- R5.2: Add an annotation API endpoint `POST /job/:id/annotate` that accepts `{ verdict: "pass"|"fail"|"partial", feedback?: string, categories?: string[] }` — stores annotation linked to job ID, agent, model, prompt, duration, token cost, iteration count, files changed
- R5.3: Annotations must also be submittable via channel adapters: after job completion, the channel sends "Did this work? Reply pass/fail/partial" — human response is parsed and stored as annotation
- R5.4: Annotations must be submittable via the MCP server tool `annotate` — allowing the agent itself to self-assess (with human override)
- R5.5: Implement a reliability scoring engine that computes per-dimension scores:
  - Per-agent reliability (pass rate across all tasks)
  - Per-model reliability (pass rate per LLM model)
  - Per-domain reliability (pass rate by task category — frontend, backend, infra, docs, etc.)
  - Per-complexity reliability (pass rate by iteration count / token cost brackets)
  - Trend over time (7-day rolling average, 30-day rolling average)
- R5.6: Domain categorization must be automatic: analyze job prompt using keyword extraction and clustering to assign categories (frontend, backend, database, infra, docs, testing, etc.) — no ML model required, use configurable keyword-to-category mapping
- R5.7: Implement a recommendation engine that generates actionable suggestions based on annotation data:
  - "React tasks fail 60% of the time. Consider adding React component examples to knowledge."
  - "Model X succeeds 94% on Python but only 45% on TypeScript. Consider model Y for TypeScript tasks."
  - "Instance has handled 200+ tasks this month across 5 domains. Consider splitting into 2 specialized instances: [frontend, backend]."
  - "Success rate improved 15% after adding rule X to identity. Keep it."
- R5.8: Recommendations must be surfaced via: dashboard widget, CLI command `randal analytics recommendations`, and periodic channel notifications (configurable frequency)
- R5.9: Implement a feedback injection system: the analytics engine automatically adds empirical guidance to the system prompt based on annotation patterns — e.g., "Your historical success rate on database migration tasks is 40%. Always create a backup first and verify schema compatibility before migrating."
- R5.10: Store all annotation data in Meilisearch index `randal-annotations-{instance}` with fields: `jobId, verdict, feedback, agent, model, domain, iterationCount, tokenCost, duration, filesChanged, prompt (first 500 chars), timestamp`
- R5.11: Add config fields: `analytics: { enabled, autoAnnotationPrompt, feedbackInjection, recommendationFrequency: "daily"|"weekly"|"on-demand", domainKeywords: Record<string, string[]> }`
- R5.12: Add API endpoints: `GET /analytics/scores` (reliability scores), `GET /analytics/recommendations` (current recommendations), `GET /analytics/trends` (time-series data), `GET /analytics/annotations` (raw annotation list with filters)
- R5.13: The analytics engine must handle cold-start gracefully — with fewer than 10 annotations, show "insufficient data" rather than unreliable scores
- R5.14: Implement annotation aging: older annotations carry less weight (exponential decay with configurable half-life, default 30 days)

### R6: Expanded Channel Adapters

- R6.1: Implement `TelegramChannel` in `packages/gateway/src/channels/telegram.ts` using `telegraf` — support text messages, voice messages (transcribed via STT), file sharing, group mentions, `allowFrom` filter by Telegram user ID
- R6.2: Implement `SlackChannel` in `packages/gateway/src/channels/slack.ts` using `@slack/bolt` — support text messages in DMs and channels, thread replies, app mentions, `allowFrom` filter by Slack user ID, slash commands (`/randal run`, `/randal status`)
- R6.3: Implement `EmailChannel` in `packages/gateway/src/channels/email.ts` using `nodemailer` + `imapflow` — support inbound email monitoring (IMAP IDLE), outbound email responses, `allowFrom` filter by email address, subject-line parsing for commands
- R6.4: Implement `WhatsAppChannel` in `packages/gateway/src/channels/whatsapp.ts` — evaluate Twilio WhatsApp API (officially supported, paid) vs Baileys (unofficial, free but GPL). Default to Twilio WhatsApp API for reliability. Support text, voice messages, media.
- R6.5: Implement `SignalChannel` in `packages/gateway/src/channels/signal.ts` using `signal-cli` subprocess — support text messages, `allowFrom` filter by phone number
- R6.6: All new channel adapters must pass the shared `handleCommand()` function for command parsing and support `formatEvent()` for event notification delivery
- R6.7: All new channel adapters must support `JobOrigin` tracking so that job completion/failure notifications route back to the originating channel and thread/conversation
- R6.8: Add config schema entries for each new channel type in the `channelSchema` discriminated union with appropriate fields (tokens, API keys, allowFrom filters)
- R6.9: Each channel adapter must have a health check mechanism and auto-reconnect on disconnection with exponential backoff (initial 1s, max 5 minutes)

### R7: Browser Automation

- R7.1: Create a browser tool module at `packages/runner/src/tools/browser.ts` that launches and controls a headless Chromium instance via CDP (Chrome DevTools Protocol)
- R7.2: Expose browser capabilities as an MCP tool: `browser_navigate(url)`, `browser_screenshot()`, `browser_click(selector)`, `browser_type(selector, text)`, `browser_evaluate(script)`, `browser_get_content(selector?)`
- R7.3: Implement page snapshot extraction: convert current page DOM to a simplified text representation (similar to Openclaw's approach) for feeding to the LLM without sending full screenshots
- R7.4: Support browser profile persistence: cookies, localStorage, and session data can be saved/restored across agent sessions for maintaining authentication state
- R7.5: Implement configurable browser sandbox: option to run browser in a Docker container with network restrictions
- R7.6: Add browser config fields: `browser: { enabled, headless, profileDir, sandbox, viewport: { width, height }, timeout }`
- R7.7: The browser tool must work in headless Docker environments (no display server required)
- R7.8: Implement anti-detection measures: randomized viewport, user agent rotation, request timing jitter — to avoid being blocked by bot detection

### R8: Context Compaction

- R8.1: Implement LLM-based context compaction in `packages/runner/src/compaction.ts` — when accumulated iteration context exceeds a configurable threshold (default: 80% of model context window), summarize older iterations using a fast/cheap model
- R8.2: Compaction must preserve: current plan state, most recent 2 iterations in full detail, all delegation results, all human-injected context, all memory entries
- R8.3: Compacted context must clearly mark what was summarized vs preserved in full: `## Compacted History (iterations 1-15 summarized)\n<summary>\n## Recent Iterations (full detail)\n<iteration 16-18>`
- R8.4: Add config field: `runner.compaction: { enabled, threshold, model, maxSummaryTokens }`
- R8.5: The compaction model should default to a fast, cheap model (e.g., `anthropic/claude-haiku-3`) regardless of the main agent model
- R8.6: Emit a new event type `job.compacted` when compaction occurs, with data `{ iterationsCompacted, originalTokens, compactedTokens }`

### R9: Testing Strategy

#### R9.1: Unit Tests (one test file per source module)

- R9.1.1: `packages/voice/src/voice-engine.test.ts` — test LiveKit room creation/join/leave, STT/TTS pipeline initialization, session lifecycle, error handling with mocked LiveKit SDK
- R9.1.2: `packages/voice/src/call-parser.test.ts` — test `<call>` tag parsing with valid/invalid/malformed inputs, phone number validation, script extraction
- R9.1.3: `packages/voice/src/join-call-parser.test.ts` — test `<join_call>` tag parsing with various platforms, meeting IDs, passcodes
- R9.1.4: `packages/mesh/src/registry.test.ts` — test instance registration, deregistration, heartbeat updates, stale instance cleanup, concurrent registrations
- R9.1.5: `packages/mesh/src/discovery.test.ts` — test instance discovery queries, filtering by capability/specialization/health, empty results handling
- R9.1.6: `packages/mesh/src/router.test.ts` — test workload routing algorithm with various weight configurations, tie-breaking, fallback to local execution when no peers available
- R9.1.7: `packages/mesh/src/health.test.ts` — test health monitoring, missed ping tracking, unhealthy marking, auto-deregistration
- R9.1.8: `packages/analytics/src/annotations.test.ts` — test annotation storage, retrieval, filtering by verdict/agent/model/domain, validation of annotation schema
- R9.1.9: `packages/analytics/src/scoring.test.ts` — test reliability score computation per-agent/per-model/per-domain, cold-start handling (<10 annotations), annotation aging/decay
- R9.1.10: `packages/analytics/src/recommendations.test.ts` — test recommendation generation from various annotation distributions (high failure rate, model divergence, domain clustering, split suggestions)
- R9.1.11: `packages/analytics/src/categorizer.test.ts` — test domain categorization from prompts using keyword matching, custom keyword maps, ambiguous inputs
- R9.1.12: `packages/analytics/src/feedback-injector.test.ts` — test prompt injection of empirical guidance, threshold checks, formatting
- R9.1.13: `packages/runner/src/streaming.test.ts` — test line-by-line stream reader, backpressure handling, partial line buffering, timeout behavior
- R9.1.14: `packages/runner/src/mcp-server.test.ts` — test MCP server tool registration, request handling, concurrent connections, error responses
- R9.1.15: `packages/runner/src/compaction.test.ts` — test context compaction trigger threshold, preservation rules (plan, recent iterations, delegations), summary formatting
- R9.1.16: `packages/runner/src/tools/browser.test.ts` — test browser launch/close, navigation, screenshot capture, DOM extraction, profile persistence (with mocked CDP)
- R9.1.17: `packages/runner/src/agents/claude-code.test.ts` — extend existing tests: add `parseToolUse()` tests for real Claude Code output patterns
- R9.1.18: `packages/runner/src/agents/opencode.test.ts` — extend existing tests: add `parseToolUse()` tests for real OpenCode output patterns
- R9.1.19: `packages/gateway/src/channels/telegram.test.ts` — test message handling, allowFrom filtering, voice message detection, command parsing, event forwarding
- R9.1.20: `packages/gateway/src/channels/slack.test.ts` — test message handling, thread replies, app mention detection, slash commands, allowFrom filtering
- R9.1.21: `packages/gateway/src/channels/email.test.ts` — test IMAP connection, message parsing, subject-line command extraction, SMTP reply sending, allowFrom filtering
- R9.1.22: `packages/gateway/src/channels/voice.test.ts` — test voice session lifecycle, STT text routing to job submission, TTS response delivery, call duration tracking
- R9.1.23: `packages/gateway/src/channels/whatsapp.test.ts` — test message handling, media handling, allowFrom filtering, command parsing
- R9.1.24: `packages/gateway/src/channels/signal.test.ts` — test subprocess management, message handling, allowFrom filtering

#### R9.2: Integration Tests

- R9.2.1: `tests/integration/streaming-events.test.ts` — verify that tool use events are emitted in real-time during agent execution (use mock adapter with timed output)
- R9.2.2: `tests/integration/mcp-agent.test.ts` — verify that a mock agent can connect to the MCP server and call Randal tools (memory search, annotate) during execution
- R9.2.3: `tests/integration/annotation-feedback.test.ts` — verify end-to-end: submit job -> complete -> annotate via API -> analytics scores update -> feedback injected into next job's prompt
- R9.2.4: `tests/integration/mesh-routing.test.ts` — verify that two Runner instances with mesh enabled can discover each other and route tasks based on specialization
- R9.2.5: `tests/integration/mesh-delegation.test.ts` — verify cross-instance job delegation: instance A submits to instance B, result flows back to A
- R9.2.6: `tests/integration/voice-to-job.test.ts` — verify that a simulated voice input (mock STT text) flows through the voice channel adapter to job submission and back through TTS (mocked)
- R9.2.7: `tests/integration/channel-routing.test.ts` — verify that job completion notifications route back to the correct originating channel (test with 3+ channels active)
- R9.2.8: `tests/integration/compaction.test.ts` — verify that context compaction triggers at threshold, preserves required sections, and subsequent iterations receive compacted context
- R9.2.9: `tests/integration/browser-tool.test.ts` — verify browser MCP tool end-to-end: agent requests browser_navigate -> browser opens page -> returns content -> agent processes

#### R9.3: E2E Tests

- R9.3.1: `tests/e2e/voice-call.test.ts` — full voice call E2E (with mocked LiveKit/Twilio): inbound call -> STT -> job execution -> TTS response -> call ends. Verify transcript, job state, cost tracking
- R9.3.2: `tests/e2e/mesh-collaboration.test.ts` — two Randal instances boot, register in mesh, one receives a task, routes to the other based on specialization, task completes, result returned to originator
- R9.3.3: `tests/e2e/self-learning-loop.test.ts` — submit 10 jobs -> annotate with mixed verdicts -> verify analytics scores -> verify recommendations generated -> verify feedback injection in subsequent job prompt
- R9.3.4: `tests/e2e/multi-channel.test.ts` — submit jobs via HTTP, Discord (mocked), and voice (mocked) simultaneously, verify all complete and notifications route to correct channels
- R9.3.5: `tests/e2e/outbound-call.test.ts` — agent outputs `<call>` tag -> runner parses -> mock outbound call initiated -> transcript injected into next iteration
- R9.3.6: `tests/e2e/video-join.test.ts` — agent outputs `<join_call>` tag -> VoiceEngine joins mock room -> receives video frames -> processes via mock vision model -> agent receives visual context

#### R9.4: Test Infrastructure

- R9.4.1: Create `tests/helpers/` directory with shared test utilities: `makeConfig()`, `makeTmpDir()`, `makeMockRunner()`, `makeMockEventBus()`, `makeMockMemoryStore()`, `makeMockVoiceEngine()`, `makeMockMeshRegistry()`
- R9.4.2: Create `tests/helpers/mock-livekit.ts` — mock LiveKit server SDK that simulates room creation, participant joins, track publishing/subscribing without a real LiveKit server
- R9.4.3: Create `tests/helpers/mock-twilio.ts` — mock Twilio SDK that simulates call creation, SIP connections, phone number management
- R9.4.4: Create `tests/helpers/mock-channels.ts` — mock implementations of Telegram, Slack, WhatsApp, Signal, Email adapters for integration testing
- R9.4.5: Add `test:voice`, `test:mesh`, `test:analytics`, `test:channels` scripts to root `package.json` for targeted test runs
- R9.4.6: Update `.github/workflows/` to include a CI workflow that runs `bun run check` (typecheck + lint + all tests) on every PR and push to main
- R9.4.7: CI must gate on: all tests pass, type checking passes, linting passes — with failure blocking merge

### R10: Documentation

- R10.1: Update `README.md` with new feature sections: Voice & Video, Multi-Instance Mesh, Self-Learning Analytics, Expanded Channels, Browser Automation
- R10.2: Update `docs/architecture.md` with new package diagram including `packages/voice/`, `packages/mesh/`, `packages/analytics/`, and their relationships
- R10.3: Update `docs/config-reference.md` with all new config fields (voice, mesh, analytics, browser, compaction, new channel types) including types, defaults, descriptions, and examples
- R10.4: Create `docs/voice-video-guide.md` — setup guide for LiveKit (self-hosted and cloud), Twilio SIP trunk configuration, STT/TTS provider setup, browser voice widget integration, video call participation, outbound calling
- R10.5: Create `docs/mesh-guide.md` — multi-instance setup, specialization configuration, routing algorithm explanation, health monitoring, job migration, split recommendations
- R10.6: Create `docs/analytics-guide.md` — annotation workflow, reliability scoring explanation, recommendation engine, feedback injection, dashboard analytics views
- R10.7: Create `docs/channel-adapters-guide.md` — setup guide for each channel (Telegram, Slack, WhatsApp, Signal, Email) with configuration examples, bot/app creation instructions, and security considerations
- R10.8: Create `docs/browser-automation-guide.md` — browser tool setup, CDP usage, profile persistence, sandbox configuration, Docker headless setup
- R10.9: Update `docs/cli-reference.md` with new commands: `randal mesh status`, `randal mesh route`, `randal analytics scores`, `randal analytics recommendations`, `randal voice status`
- R10.10: Create example configs in `examples/`: `voice-enabled/`, `multi-instance-mesh/`, `analytics-driven/`, `full-platform/`
- R10.11: Update dashboard (`packages/dashboard/src/index.html`) with: voice session panel (active calls, duration, transcript), mesh status panel (peer instances, health, routing), analytics dashboard (reliability charts, recommendation cards, annotation history)

---

## Architecture

### Package Dependency Graph (Updated)

```
                          ┌──────────┐
                          │  @randal/ │
                          │   core   │  (types, config, logger, prompt)
                          └────┬─────┘
                               │
            ┌──────────────────┼──────────────────────┐
            │                  │                      │
    ┌───────┴────────┐  ┌──────┴───────┐    ┌────────┴────────┐
    │  @randal/       │  │  @randal/    │    │  @randal/        │
    │  credentials    │  │  memory      │    │  analytics       │ NEW
    └───────┬────────┘  └──────┬───────┘    └────────┬────────┘
            │                  │                      │
            └──────────────────┼──────────────────────┘
                               │
                      ┌────────┴────────┐
                      │  @randal/runner  │  (execution loop, adapters,
                      │                  │   sentinel, streaming, MCP,
                      │                  │   compaction, browser tool)
                      └────────┬────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
    ┌─────────┴──────┐  ┌─────┴──────┐  ┌──────┴──────┐
    │ @randal/        │  │ @randal/   │  │ @randal/     │
    │ scheduler       │  │ voice      │  │ mesh         │ NEW
    │                 │  │            │  │              │
    └─────────┬──────┘  └─────┬──────┘  └──────┬──────┘
              │               │                │
              └───────────────┼────────────────┘
                              │
                     ┌────────┴────────┐
                     │ @randal/gateway  │  (HTTP, EventBus, channels:
                     │                  │   discord, imessage, telegram,
                     │                  │   slack, email, whatsapp,
                     │                  │   signal, voice)
                     └────────┬────────┘
                              │
                     ┌────────┴────────┐
                     │ @randal/harness  │  (createRandal() unified API)
                     └────────┬────────┘
                              │
                     ┌────────┴────────┐
                     │  @randal/cli     │  (CLI entry point)
                     └─────────────────┘
```

### Data Flow: Voice Call

```
Phone/Browser
      │
      ▼
┌─────────────┐     ┌──────────────────────────────┐
│  LiveKit     │────▶│  VoiceChannel Adapter         │
│  Server      │◀────│  (packages/gateway/channels/) │
│  (WebRTC/SIP)│     │                                │
└─────────────┘     │  Inbound:                      │
                    │    STT text → handleCommand()  │
                    │    → Runner.submit()            │
                    │                                │
                    │  Outbound:                      │
                    │    job.complete event           │
                    │    → TTS → LiveKit audio track  │
                    └────────────────────────────────┘
```

### Data Flow: Multi-Instance Mesh

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Instance A  │────▶│  Meilisearch │◀────│  Instance B  │
│  (hub)       │     │  Registry    │     │  (backend)   │
└──────┬──────┘     └──────────────┘     └──────┬──────┘
       │                                        │
       │  1. Job arrives at A                   │
       │  2. Mesh evaluates routing             │
       │  3. Routes to B (specialization match) │
       │  ──────── POST /job ──────────────────▶│
       │                                        │
       │  4. B executes job                     │
       │  5. B completes, stores result         │
       │                                        │
       │◀───────── Result via shared memory ────│
       │  6. A picks up result, injects into    │
       │     parent job context                 │
```

### Data Flow: Self-Learning Loop

```
┌─────────┐    ┌──────────┐    ┌──────────────┐    ┌──────────────┐
│  Job     │───▶│ Complete  │───▶│ Annotation   │───▶│ Analytics    │
│  Runs    │    │ Event     │    │ Request      │    │ Engine       │
└─────────┘    └──────────┘    │ (channel msg) │    │              │
                               └───────┬──────┘    │ Scores       │
                                       │           │ Recommend.   │
                               ┌───────┴──────┐    │ Trends       │
                               │ Human        │    └──────┬───────┘
                               │ Verdict      │           │
                               │ pass/fail    │           ▼
                               └──────────────┘    ┌──────────────┐
                                                   │ Feedback     │
                                                   │ Injection    │
                                                   │ (next job    │
                                                   │  prompt)     │
                                                   └──────────────┘
```

---

## Implementation Plan

Implementation is ordered by dependency — each phase builds on the previous.

### Phase 1: Foundation — Real-Time Streaming & MCP (Week 1-2)

**Dependency: None (extends existing runner)**

1. Refactor `readStream()` in `packages/runner/src/runner.ts` to a `StreamingReader` class that emits lines incrementally
2. Wire `parseToolUse()` calls into the streaming reader for claude-code and opencode adapters
3. Add `iteration.tool_use` and `iteration.output` event types to `RunnerEventType`
4. Implement MCP server in `packages/runner/src/mcp-server.ts` using `@modelcontextprotocol/sdk`
5. Register MCP tools: `memory_search`, `context_inject`, `job_status`, `skill_search`, `annotate`
6. Update claude-code adapter to pass `--mcp-server` when MCP is enabled
7. Add `runner.mcpServer` config fields to Zod schema
8. Write unit tests for streaming reader, tool use parsers, MCP server
9. Write integration test for MCP agent communication
10. Update config reference docs

### Phase 2: Analytics & Self-Learning (Week 2-3)

**Dependency: Phase 1 (MCP annotate tool)**

1. Create `packages/analytics/` package with `annotations.ts`, `scoring.ts`, `recommendations.ts`, `categorizer.ts`, `feedback-injector.ts`
2. Implement annotation storage in Meilisearch (`randal-annotations-{instance}` index)
3. Implement reliability scoring engine with per-agent/model/domain breakdown
4. Implement domain categorizer using configurable keyword-to-category mapping
5. Implement recommendation generator with threshold-based rules
6. Implement feedback injector that reads analytics and appends guidance to system prompt
7. Add `POST /job/:id/annotate`, `GET /analytics/scores`, `GET /analytics/recommendations`, `GET /analytics/trends`, `GET /analytics/annotations` endpoints to HTTP channel
8. Add annotation prompt to channel adapters (post-job-completion message asking for verdict)
9. Add `analytics` config section to Zod schema
10. Add `randal analytics scores` and `randal analytics recommendations` CLI commands
11. Write unit tests for all analytics modules
12. Write integration test for full annotation-feedback loop
13. Write E2E test for self-learning loop (10 jobs, annotations, feedback verification)
14. Write analytics guide docs

### Phase 3: Voice & Video (Week 3-5)

**Dependency: Phase 1 (streaming for real-time voice interaction)**

1. Create `packages/voice/` package with `voice-engine.ts`, `stt.ts`, `tts.ts`, `sip.ts`, `session.ts`
2. Implement `VoiceEngine` class wrapping LiveKit Agents SDK (Node.js)
3. Implement STT provider abstraction (Deepgram, OpenAI Whisper, AssemblyAI)
4. Implement TTS provider abstraction (ElevenLabs, Cartesia, OpenAI TTS, Edge TTS)
5. Implement SIP integration with Twilio for phone calls (inbound + outbound)
6. Implement `VoiceChannel` adapter in `packages/gateway/src/channels/voice.ts`
7. Implement `<call>` structured tag parser in runner
8. Implement `<join_call>` structured tag parser in runner
9. Add WebRTC "Talk" button to dashboard
10. Implement video room participation (screen share reception + vision model integration)
11. Implement screen share publishing (via steer screenshots or headless browser)
12. Add `voice` config section to Zod schema
13. Write unit tests for voice engine, call parser, join-call parser
14. Write integration test for voice-to-job flow
15. Write E2E tests for voice call and video join scenarios
16. Write voice/video guide docs

### Phase 4: Multi-Instance Mesh (Week 4-6)

**Dependency: Phase 2 (analytics for routing scores)**

1. Create `packages/mesh/` package with `registry.ts`, `discovery.ts`, `router.ts`, `health.ts`, `migration.ts`
2. Implement instance registry in Meilisearch (`randal-mesh-{posse}` index)
3. Implement instance discovery with capability/specialization/health filtering
4. Implement health monitoring with missed-ping tracking and auto-deregistration
5. Implement workload routing algorithm with configurable weights (specialization, reliability, load, model match)
6. Implement cross-instance job delegation via HTTP POST
7. Implement `<route>` structured tag parser in runner
8. Implement job migration (pause on A, resume on B with full state transfer)
9. Integrate mesh into gateway boot sequence (register on start, deregister on stop)
10. Add `randal mesh status` and `randal mesh route` CLI commands
11. Add `mesh` config section to Zod schema
12. Write unit tests for all mesh modules
13. Write integration tests for mesh routing and delegation
14. Write E2E test for two-instance collaboration
15. Write mesh guide docs

### Phase 5: Expanded Channels (Week 5-7)

**Dependency: Phase 1 (event system), independent of Phases 2-4**

1. Implement `TelegramChannel` adapter using `telegraf`
2. Implement `SlackChannel` adapter using `@slack/bolt`
3. Implement `EmailChannel` adapter using `nodemailer` + `imapflow`
4. Implement `WhatsAppChannel` adapter using Twilio WhatsApp API
5. Implement `SignalChannel` adapter using `signal-cli` subprocess
6. Add config schema entries for each new channel type
7. Update gateway boot sequence to start new channel types
8. Write unit tests for each channel adapter (mocked SDKs)
9. Write integration test for multi-channel routing
10. Write channel adapters guide docs

### Phase 6: Browser Automation (Week 6-7)

**Dependency: Phase 1 (MCP tools for browser exposure)**

1. Implement browser tool module in `packages/runner/src/tools/browser.ts` using Playwright
2. Register browser tools on MCP server: `browser_navigate`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_evaluate`, `browser_get_content`
3. Implement page snapshot (DOM -> simplified text)
4. Implement browser profile persistence
5. Implement browser sandbox mode (Docker container option)
6. Add `browser` config section to Zod schema
7. Write unit tests for browser tool (mocked CDP)
8. Write integration test for browser MCP tool E2E
9. Write browser automation guide docs

### Phase 7: Context Compaction (Week 6-7)

**Dependency: Phase 1 (streaming for token counting)**

1. Implement compaction module in `packages/runner/src/compaction.ts`
2. Implement threshold detection (percentage of model context window used)
3. Implement preservation rules (plan, recent iterations, delegations, human context)
4. Implement LLM-based summarization call using configurable compaction model
5. Wire compaction into the iteration loop (between memory injection and prompt assembly)
6. Add `runner.compaction` config fields to Zod schema
7. Add `job.compacted` event type
8. Write unit tests for compaction module
9. Write integration test for compaction trigger and preservation

### Phase 8: Dashboard & Polish (Week 7-8)

**Dependency: Phases 1-7**

1. Update dashboard with voice session panel (active calls, duration, transcript preview)
2. Update dashboard with mesh status panel (peer instances, health indicators, routing log)
3. Update dashboard with analytics section (reliability score gauges, recommendation cards, annotation timeline, domain breakdown charts)
4. Add "Talk" WebRTC button to dashboard for browser-based voice
5. Add "Annotate" buttons to completed job cards
6. Update all example configs in `examples/`
7. Final documentation review — ensure all new features are covered in README, architecture, config reference
8. Add CI workflow (`.github/workflows/ci.yml`) running `bun run check` on PR/push

### Phase 9: Hardening & E2E Verification (Week 8-9)

**Dependency: Phases 1-8**

1. Run full E2E test suite, fix failures
2. Load testing: mesh with 5+ instances, 50+ concurrent jobs, verify routing stability
3. Chaos testing: kill instances mid-job, verify recovery and re-routing
4. Voice latency testing: measure end-to-end response time (target <500ms STT+LLM+TTS)
5. Security review: audit all new endpoints for auth, validate all new config fields for injection
6. Memory leak testing: long-running daemon with voice/mesh active for 24+ hours
7. Documentation proofreading and link verification
8. Final `just check` pass on clean checkout

---

## Acceptance Criteria

### AC1: Real-Time Streaming & MCP
- [ ] Running `bun test packages/runner/src/streaming.test.ts` passes — verifies line-by-line streaming with backpressure
- [ ] Running `bun test packages/runner/src/mcp-server.test.ts` passes — verifies all 5 MCP tools respond correctly
- [ ] Running `bun test packages/runner/src/agents/claude-code.test.ts` passes — includes `parseToolUse()` tests
- [ ] Running `bun test packages/runner/src/agents/opencode.test.ts` passes — includes `parseToolUse()` tests
- [ ] Running `bun test tests/integration/streaming-events.test.ts` passes — verifies real-time `iteration.tool_use` events during execution
- [ ] Running `bun test tests/integration/mcp-agent.test.ts` passes — verifies mock agent calls MCP tools
- [ ] Existing tests pass without modification: `bun test packages/runner/src/runner.test.ts`
- [ ] Config with `runner.mcpServer.enabled: false` (default) behaves identically to current behavior

### AC2: Analytics & Self-Learning
- [ ] Running `bun test packages/analytics/` passes — all unit tests for annotations, scoring, recommendations, categorizer, feedback injector
- [ ] Running `bun test tests/integration/annotation-feedback.test.ts` passes
- [ ] Running `bun test tests/e2e/self-learning-loop.test.ts` passes — 10 jobs, annotations, scores, recommendations, feedback injection verified
- [ ] `POST /job/:id/annotate` returns 200 with valid annotation, 400 with invalid verdict, 404 with unknown job ID
- [ ] `GET /analytics/scores` returns reliability scores broken down by agent, model, and domain
- [ ] `GET /analytics/recommendations` returns actionable text recommendations
- [ ] With <10 annotations, scores endpoint returns `{ status: "insufficient_data" }` instead of unreliable scores
- [ ] After 20+ annotations with a clear failure pattern, the feedback injector adds relevant guidance to the system prompt of subsequent jobs

### AC3: Voice & Video
- [ ] Running `bun test packages/voice/` passes — all unit tests for voice engine, parsers
- [ ] Running `bun test packages/gateway/src/channels/voice.test.ts` passes
- [ ] Running `bun test tests/integration/voice-to-job.test.ts` passes — mocked STT text flows to job submission and back through TTS
- [ ] Running `bun test tests/e2e/voice-call.test.ts` passes — full inbound call lifecycle with mocked LiveKit/Twilio
- [ ] Running `bun test tests/e2e/outbound-call.test.ts` passes — agent `<call>` tag triggers mock outbound call
- [ ] Running `bun test tests/e2e/video-join.test.ts` passes — agent `<join_call>` tag triggers mock room join with vision
- [ ] Config with `voice.enabled: false` (default) does not import or initialize LiveKit/Twilio dependencies
- [ ] Voice channel respects `allowFrom` phone number filters

### AC4: Multi-Instance Mesh
- [ ] Running `bun test packages/mesh/` passes — all unit tests for registry, discovery, router, health
- [ ] Running `bun test tests/integration/mesh-routing.test.ts` passes — two instances discover and route
- [ ] Running `bun test tests/integration/mesh-delegation.test.ts` passes — cross-instance job delegation with result return
- [ ] Running `bun test tests/e2e/mesh-collaboration.test.ts` passes — full two-instance boot, register, route, execute, return
- [ ] Instance appears in `GET /mesh/status` within 60 seconds of boot
- [ ] Instance is marked unhealthy after 3 missed health checks (3 minutes)
- [ ] Instance is deregistered after 10 minutes of no heartbeat
- [ ] `randal mesh status` CLI command shows all instances with health, load, specialization
- [ ] `randal mesh route "build a React component"` shows which instance would handle the task and routing score breakdown

### AC5: Expanded Channels
- [ ] Running `bun test packages/gateway/src/channels/telegram.test.ts` passes
- [ ] Running `bun test packages/gateway/src/channels/slack.test.ts` passes
- [ ] Running `bun test packages/gateway/src/channels/email.test.ts` passes
- [ ] Running `bun test packages/gateway/src/channels/whatsapp.test.ts` passes
- [ ] Running `bun test packages/gateway/src/channels/signal.test.ts` passes
- [ ] Running `bun test tests/e2e/multi-channel.test.ts` passes — concurrent jobs from 3+ channels, correct notification routing
- [ ] All new channel adapters implement `ChannelAdapter` interface and use shared `handleCommand()` and `formatEvent()`
- [ ] Each channel adapter auto-reconnects on disconnection with exponential backoff
- [ ] Existing Discord and iMessage tests pass without modification

### AC6: Browser Automation
- [ ] Running `bun test packages/runner/src/tools/browser.test.ts` passes
- [ ] Running `bun test tests/integration/browser-tool.test.ts` passes — navigate, screenshot, content extraction E2E
- [ ] Browser tool works in headless mode (no display server)
- [ ] Browser profile persistence saves and restores cookies/localStorage across sessions
- [ ] Config with `browser.enabled: false` (default) does not launch any browser processes

### AC7: Context Compaction
- [ ] Running `bun test packages/runner/src/compaction.test.ts` passes
- [ ] Running `bun test tests/integration/compaction.test.ts` passes — compaction triggers at threshold, preserves plan/recent/delegations
- [ ] `job.compacted` event is emitted with correct token counts
- [ ] Compaction preserves the most recent 2 iterations in full detail
- [ ] Compaction preserves all human-injected context
- [ ] Config with `runner.compaction.enabled: false` (default) skips compaction entirely

### AC8: Documentation
- [ ] `README.md` includes sections for Voice & Video, Multi-Instance Mesh, Self-Learning Analytics, Expanded Channels, Browser Automation
- [ ] `docs/architecture.md` includes updated package dependency diagram
- [ ] `docs/config-reference.md` includes all new config fields with types, defaults, and descriptions
- [ ] `docs/voice-video-guide.md` exists and covers LiveKit setup, Twilio SIP, STT/TTS providers, browser voice, video calls
- [ ] `docs/mesh-guide.md` exists and covers multi-instance setup, specialization, routing, health monitoring
- [ ] `docs/analytics-guide.md` exists and covers annotation workflow, scoring, recommendations, feedback injection
- [ ] `docs/channel-adapters-guide.md` exists and covers all 5 new channel types with setup instructions
- [ ] `docs/browser-automation-guide.md` exists and covers browser tool setup, CDP, profiles, sandbox
- [ ] `docs/cli-reference.md` includes `mesh`, `analytics`, and `voice` commands
- [ ] All example configs in `examples/` are valid and parseable by the updated Zod schema

### AC9: CI & Quality Gates
- [ ] `.github/workflows/ci.yml` exists and runs `bun run check` (typecheck + lint + test) on PR and push to main
- [ ] `bun run typecheck` passes with zero errors
- [ ] `bun run lint` passes with zero errors
- [ ] `bun test` passes — all unit, integration, and E2E tests
- [ ] Docker image builds successfully with all new packages included
- [ ] Existing configs (all files in `examples/`) parse without errors against the updated schema

### AC10: Backward Compatibility
- [ ] A `randal.config.yaml` file with zero new fields parses successfully and all new features default to disabled
- [ ] `randal run "hello"` works identically to pre-change behavior when no new config is present
- [ ] `randal serve` starts with only HTTP channel when no new channels are configured
- [ ] All 44 existing test files pass without modification
- [ ] The `mock` agent adapter works unchanged for testing purposes

---

## Completion Promise

<promise>COMPLETE</promise>
