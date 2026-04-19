# Voice Deployment Split

Voice is optional. When you do enable it in production, do not think of it as
"one Docker compose file starts everything." The real deployment is split across
three concerns:

1. The Randal gateway/runner process
2. A public HTTPS/WSS entrypoint for Randal's voice routes
3. Public LiveKit + SIP/media infrastructure

For this branch's intended architecture, the gateway/runner stays on Railway and
the voice/media side is exposed through public infrastructure that Twilio and
remote clients can reach.

## Railway-hosted pieces

- `@randal/gateway` HTTP API and the Step 2 runner bridge
- `@randal/voice` runtime/bootstrap code invoked by the gateway
- Memory, jobs, and non-voice channels

This is the application process started by `randal serve`.

## Gateway-hosted voice endpoints

These routes are implemented by `@randal/gateway` and executed inside the same
Randal gateway/runtime process as the runner bridge:

- Twilio webhooks:
  - `POST /voice/twiml/inbound`
  - `POST /voice/twiml/outbound/:sessionId`
  - `POST /voice/twilio/status/:sessionId`
  - `POST /voice/twilio/stream-status/:sessionId`
- Twilio websocket media endpoint:
  - `GET /voice/media-stream/:sessionId`

These routes must be reachable at the public HTTPS/WebSocket base URL exposed as
`RANDAL_VOICE_PUBLIC_URL`. That public entrypoint can be:

- the Railway-hosted gateway itself, if it is directly reachable by Twilio and suitable for WebSocket traffic
- or a dedicated public reverse proxy / edge host that forwards to the same gateway runtime

`RANDAL_VOICE_PUBLIC_URL` should point at this public gateway entrypoint, not at
the LiveKit WebSocket endpoint.

## Public media infrastructure

- LiveKit server
- LiveKit SIP bridge
- any public SIP/RTP exposure required for Twilio trunking

These pieces are separate from the Randal gateway process. The local
`docker-compose.voice.yml` file is only a dev convenience for this media layer.

## Required environment split

Set these on the Railway-hosted gateway service when voice is enabled:

```bash
RANDAL_VOICE_PUBLIC_URL=https://voice.example.com
LIVEKIT_URL=wss://voice.example.com
LIVEKIT_API_KEY=<livekit api key>
LIVEKIT_API_SECRET=<livekit api secret>
DEEPGRAM_API_KEY=<deepgram key>
ELEVENLABS_API_KEY=<elevenlabs key>
ELEVENLABS_VOICE_ID=<optional voice id>
TWILIO_ACCOUNT_SID=<twilio account sid>
TWILIO_AUTH_TOKEN=<twilio auth token>
TWILIO_PHONE_NUMBER=<twilio number>
```

`RANDAL_VOICE_PUBLIC_URL` must point to the public HTTPS/WebSocket entrypoint for the gateway voice routes above.

Recommended interpretation of the env vars:

- `LIVEKIT_*`: how Randal connects to LiveKit
- `DEEPGRAM_API_KEY`: STT provider credential
- `ELEVENLABS_*`: TTS provider credential and optional explicit voice selection
- `TWILIO_*`: only required when PSTN phone calling is enabled
- `RANDAL_VOICE_PUBLIC_URL`: public base URL for Twilio/browser access to Randal's own voice routes

## Railway notes

- Railway is a good home for the gateway/runner because the runner bridge and webhook handlers are normal HTTP/WebSocket application traffic.
- LiveKit SIP and RTP exposure still need public media infrastructure outside the gateway process.
- If Railway is used, treat it as the gateway/brain host; expose `RANDAL_VOICE_PUBLIC_URL` through a public domain or proxy that Twilio can reach.
- The merge workflow in `.github/workflows/railway-deploy.yml` can upsert the voice env vars into the Railway service, but the external LiveKit/Twilio accounts still have to be created and wired up separately.

## Local development

Run the local voice stack with:

```bash
docker compose -f docker-compose.voice.yml up -d
```

This starts:

- Redis
- LiveKit server on `ws://localhost:7880`
- LiveKit SIP bridge on `sip:localhost:5060`

It does **not** start the Randal gateway itself. Run the gateway separately, for example with `randal serve`.

For local webhook testing, expose the gateway with a public HTTPS tunnel and set `RANDAL_VOICE_PUBLIC_URL` to that URL.

If you are not testing voice, skip this entire stack.
