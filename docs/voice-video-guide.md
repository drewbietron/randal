# Voice & Video Guide

Randal can participate in voice calls, video meetings, and outbound phone calls.
The `@randal/voice` package wires LiveKit rooms, Twilio SIP trunks, and
STT/TTS providers into the runner loop so Randal can listen, think, and speak
in real time.

---

## Architecture overview

```
Caller ──► Twilio SIP ──► LiveKit Room ──► Randal Voice Engine
                                               │
                                    ┌──────────┼──────────┐
                                    ▼          ▼          ▼
                                   STT      Runner      TTS
                                (Deepgram)  (Ralph)  (ElevenLabs)
```

1. Audio arrives via a LiveKit room (browser widget, SIP, or direct).
2. The voice engine streams audio chunks to the STT provider.
3. Transcribed text is fed into the runner as a normal message.
4. The runner's response text is sent to the TTS provider.
5. Synthesised audio is published back into the LiveKit room.

---

## LiveKit setup

### Cloud (recommended for getting started)

1. Create an account at [livekit.io](https://livekit.io).
2. Copy the **WebSocket URL**, **API Key**, and **API Secret** from the
   project dashboard.
3. Add them to your `.env`:

```bash
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=APIxxxxxxxx
LIVEKIT_API_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
```

### Self-hosted

Run LiveKit on your own infrastructure with Docker:

```bash
docker run --rm -p 7880:7880 -p 7881:7881 -p 7882:7882/udp \
  livekit/livekit-server --dev
```

For production, see the [LiveKit deployment docs](https://docs.livekit.io/home/self-hosting/deployment/).
The default dev server uses `APIxxxxxxxx` / `xxxxxxxxxxxxxxxxxxxxxxxx` as
key/secret.

For the full phone/media development stack in this repo, run:

```bash
docker compose -f docker-compose.voice.yml up -d
```

This starts:

- Redis
- LiveKit server
- LiveKit SIP bridge

Use `docker/voice/livekit.yaml` and `docker/voice/sip.yaml` as the local reference configs.
This compose file does **not** start the Randal gateway; run `randal serve` separately.

---

## Twilio SIP trunk configuration

Twilio connects PSTN phone numbers to LiveKit rooms via SIP.

1. **Buy a phone number** in the Twilio console.
2. **Create a SIP trunk** under Elastic SIP Trunking → Trunks.
3. **Set the origination URI** to your LiveKit SIP endpoint
   (e.g. `sip:your-project.livekit.cloud`).
4. **Add credentials** to `.env`:

```bash
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_PHONE_NUMBER=+15551234567
```

5. Reference them in your config:

```yaml
voice:
  enabled: true
  twilio:
    accountSid: ${TWILIO_ACCOUNT_SID}
    authToken: ${TWILIO_AUTH_TOKEN}
    phoneNumber: ${TWILIO_PHONE_NUMBER}
```

For a Railway deployment, keep the gateway/runner on Railway and point `RANDAL_VOICE_PUBLIC_URL`
at a public voice/media host that Twilio can reach. See `docs/voice-deployment-split.md`.

---

## STT provider setup

### Deepgram (default)

1. Sign up at [deepgram.com](https://deepgram.com) and create an API key.
2. Add to `.env`:

```bash
DEEPGRAM_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

3. Config:

```yaml
voice:
  stt:
    provider: deepgram
    apiKey: ${DEEPGRAM_API_KEY}
    model: nova-2          # optional, defaults to provider's latest
```

### OpenAI Whisper

```yaml
voice:
  stt:
    provider: whisper
    apiKey: ${OPENAI_API_KEY}
    model: whisper-1
```

### AssemblyAI

```yaml
voice:
  stt:
    provider: assemblyai
    apiKey: ${ASSEMBLYAI_API_KEY}
```

---

## TTS provider setup

### ElevenLabs (default)

1. Get an API key from [elevenlabs.io](https://elevenlabs.io).
2. Choose a voice ID from the voice library.

```yaml
voice:
  tts:
    provider: elevenlabs
    apiKey: ${ELEVENLABS_API_KEY}
    voice: pNInz6obpgDQGcFmaJgB    # "Adam" — or any voice ID
```

### OpenAI TTS

```yaml
voice:
  tts:
    provider: openai
    apiKey: ${OPENAI_API_KEY}
    voice: alloy
```

### Cartesia

```yaml
voice:
  tts:
    provider: cartesia
    apiKey: ${CARTESIA_API_KEY}
    voice: sonic-english
```

### Edge TTS (free, no API key)

```yaml
voice:
  tts:
    provider: edge
    voice: en-US-GuyNeural
```

---

## Browser voice widget integration

Randal ships a lightweight voice widget that connects to a LiveKit room from
the browser. To enable it:

1. Make sure the `voice` channel is in your gateway config:

```yaml
gateway:
  channels:
    - type: voice
```

2. The dashboard (served by `@randal/dashboard`) automatically renders a
   microphone button when voice is enabled.
3. Clicking the button requests a LiveKit participant token from the gateway,
   joins the room, and streams audio.

For custom UIs, use the
[LiveKit JavaScript SDK](https://docs.livekit.io/reference/js/) and request a
token from `POST /api/voice/token`.

---

## Video call participation

Randal can join Zoom, Google Meet, and Microsoft Teams meetings via SIP or
RTMP.

### How it works

1. **SIP dial-in**: Many conferencing platforms expose SIP URIs for meetings.
   Randal uses the LiveKit SIP bridge to dial into the meeting as a
   participant.
2. **Video processing**: When `video.enabled` is true, Randal periodically
   captures frames from the video track and sends them to a vision model for
   scene understanding.

### Configuration

```yaml
voice:
  video:
    enabled: true
    visionModel: gpt-4o          # model for frame analysis
    publishScreen: false         # share Randal's screen into the call
    recordSessions: true         # save recordings locally
    recordPath: ./recordings
```

### Meeting-specific notes

| Platform       | Method           | Notes                                         |
|----------------|------------------|-----------------------------------------------|
| Zoom           | SIP URI          | Requires Zoom SIP connector add-on            |
| Google Meet    | SIP dial-in      | Available on Google Workspace Business+        |
| Microsoft Teams| SIP via Direct Routing | Requires Teams Phone System license     |

---

## Outbound calling

Randal can place outbound phone calls via Twilio:

```bash
randal call +15559876543 --prompt "Check in with the client about delivery"
```

Or programmatically through the gateway API:

```bash
curl -X POST http://localhost:7600/api/voice/call \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"to": "+15559876543", "prompt": "Check in about delivery"}'
```

The call flow:
1. Twilio places the outbound call.
2. When answered, audio is bridged into a LiveKit room.
3. The STT/Runner/TTS pipeline handles the conversation.

---

## Turn detection

The voice engine detects when the caller stops speaking before generating a
response. Two modes are available:

```yaml
voice:
  turnDetection:
    mode: auto      # VAD-based automatic detection (default)
    # mode: manual  # wait for explicit push-to-talk signal
```

---

## Full configuration example

```yaml
name: voice-assistant
runner:
  workdir: ./workspace

voice:
  enabled: true

  livekit:
    url: ${LIVEKIT_URL}
    apiKey: ${LIVEKIT_API_KEY}
    apiSecret: ${LIVEKIT_API_SECRET}

  twilio:
    accountSid: ${TWILIO_ACCOUNT_SID}
    authToken: ${TWILIO_AUTH_TOKEN}
    phoneNumber: ${TWILIO_PHONE_NUMBER}

  stt:
    provider: deepgram
    apiKey: ${DEEPGRAM_API_KEY}
    model: nova-2

  tts:
    provider: elevenlabs
    apiKey: ${ELEVENLABS_API_KEY}
    voice: pNInz6obpgDQGcFmaJgB

  turnDetection:
    mode: auto

  video:
    enabled: false

gateway:
  channels:
    - type: voice
    - type: http
      port: 7600
      auth: ${API_TOKEN}
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| No audio in room | LiveKit URL wrong or unreachable | Verify `LIVEKIT_URL` and network access |
| STT returns empty | API key invalid or rate-limited | Check provider dashboard for errors |
| High latency | STT + TTS round-trip too slow | Try `deepgram` STT + `edge` TTS for lowest latency |
| Outbound call fails | Twilio credentials or phone number misconfigured | Verify in Twilio console |
| Video frames not processed | `video.enabled` not set to `true` | Add `video.enabled: true` to config |
