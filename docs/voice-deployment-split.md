# Voice Deployment Split

Step 3 production voice hosting is split across two runtime domains:

1. Railway-hosted Randal gateway/brain runtime
2. Public network frontage for Twilio-reachable HTTPS/WebSocket traffic
3. Public LiveKit + SIP/media infrastructure

## Railway-hosted pieces

- `@randal/gateway` HTTP API and the Step 2 runner bridge
- `@randal/voice` runtime/bootstrap code invoked by the gateway
- Memory, jobs, and non-voice channels

## Gateway-hosted voice endpoints

These routes are implemented by `@randal/gateway` and executed inside the same
Randal gateway/runtime process as the Step 2 runner bridge:

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

## Public media infrastructure

- LiveKit server
- LiveKit SIP bridge
- any public SIP/RTP exposure required for Twilio trunking

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

## Railway notes

- Railway is a good home for the gateway/runner because the runner bridge and webhook handlers are normal HTTP/WebSocket application traffic.
- LiveKit SIP and RTP exposure still need public media infrastructure outside the gateway process.
- If Railway is used, treat it as the gateway/brain host; expose `RANDAL_VOICE_PUBLIC_URL` through a public domain or proxy that Twilio can reach.

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
