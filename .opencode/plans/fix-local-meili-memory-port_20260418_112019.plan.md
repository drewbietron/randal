# Plan: Fix local Meilisearch memory port resolution

**Created**: 2026-04-18T11:21:31-05:00
**File**: .opencode/plans/fix-local-meili-memory-port_20260418_112019.plan.md
**Status**: Complete
**Planning Turn**: 7 of ~7
**Model**: openai/gpt-5.4

## Summary
Local OpenCode chat-history and memory flows in `/Users/drewbie/dev/randal` are currently resolving Meilisearch to `http://localhost:7700`, while the active local development setup is exposing Meilisearch on host port `7701`. The regression appears intertwined with Railway-oriented memory changes, so the fix needs a full audit of local-vs-Railway resolution paths, with an env-driven approach preferred where it improves reliability, testability, and production safety.

## Requirements
1. Fix the local chat-history / memory path used by the symlinked OpenCode config in `/Users/drewbie/dev/randal` so it can connect to the working local Meilisearch instance instead of the broken `7700` fallback.
2. Audit Meilisearch configuration touchpoints across local OpenCode config, memory MCP wiring, and adjacent project defaults to separate local behavior from Railway behavior cleanly.
3. Prefer the most reliable env-driven configuration strategy where practical, especially if it makes local use, testing, and production deployment safer and easier to reason about.
4. Decide on and implement a clean compatibility story for local setups that may still use `localhost:7700`, or document why a stricter standard is better.
5. Verify the final change with both targeted and broader checks so the whole memory/chat-history path is credible end-to-end.

## Constraints
- Do not break Railway / production Meilisearch connectivity that depends on Railway-specific environment variables or internal networking.
- The local developer workflow includes the symlinked OpenCode config under `agent/opencode-config/`.
- Current local Docker Compose exposes Meilisearch as host `7701 -> container 7700` via `docker-compose.meili.yml`.
- The fix should be easy to test locally and straightforward to productionize inside Randal.

## Discovery Log
- Turn 2 discovery focused on the highest-value Meilisearch configuration touchpoints that can force local OpenCode memory/chat-history traffic to the wrong host port.
- `docker-compose.meili.yml` exposes local Meilisearch as host `7701 -> container 7700`, so `http://localhost:7701` is the active local Docker entrypoint in this repo.
- `agent/opencode-config/opencode.json` hardcodes `MEILI_URL=http://localhost:7700` in the memory MCP `environment` block. Because this is explicit process env injection, it overrides any downstream defaulting logic inside the MCP server for the symlinked local OpenCode workflow.
- `agent/opencode-config/plugins/chat-history.ts` separately resolves `MEILI_URL` from `process.env.MEILI_URL || "http://localhost:7700"`. This means chat-history writes have their own local fallback path and can drift from other memory callers if env wiring is incomplete or inconsistent.
- `packages/core/src/config.ts` sets the platform-level `memory.url` schema default to `http://localhost:7700`. This is an adjacent project default, not just an OpenCode-only concern, so local-vs-Railway separation likely needs to be handled at the config/env boundary rather than by changing only one caller.
- `tools/mcp-memory-server.ts` also defaults `MEILI_URL` to `http://localhost:7700`, then reuses that value for the primary memory store, chat `MessageManager`, and analytics `MeiliSearch` client. One wrong resolved URL therefore breaks multiple MCP capabilities at once, not only memory search.
- The memory MCP server's diagnostics already surface `Connection refused at ${MEILI_URL}`, which matches the current symptom and confirms that the broken target is the resolved URL rather than a later query/index issue.
- Architectural conclusion from this turn: the bug is a repeated default-resolution problem with one especially high-priority override at `agent/opencode-config/opencode.json`; a durable fix should define a canonical env-driven local resolution path and let Railway/prod continue to opt into their own env values explicitly.
- Turn 3 discovery examined the shared runtime boundary, deployment configs, and tests that currently encode Meilisearch assumptions.
- `packages/core/src/config-compile.ts` is the clearest canonical boundary discovered so far: it takes validated shared config (`config.memory.url`) and compiles that into OpenCode memory MCP process env as `MEILI_URL`. If local-vs-Railway behavior is meant to diverge cleanly, that divergence should be expressed in shared config/env resolution before or at compile time, not by ad hoc overrides later.
- `packages/cli/src/commands/serve.ts` uses `config.memory.url || "http://localhost:7700"` for Meilisearch health checks and auto-start. Its Docker fallback explicitly publishes `7700:7700`, which conflicts with this repo's checked-in local compose convention of `7701:7700`. This means the CLI's local bootstrap story and the repo's local compose story are currently inconsistent.
- `randal.config.railway.yaml` defines memory URL as `${MEILISEARCH_URL:-http://127.0.0.1:7700}` with a Railway-specific index (`memory-railway`). This confirms Railway already has an explicit env/config boundary and is not inherently tied to the local `localhost:7701` convention.
- `randal.config.ci.yaml` pins memory URL to `http://127.0.0.1:7700` with index `memory-ci`, so CI currently encodes a separate explicit test/deployment convention instead of relying on ambient local defaults.
- `packages/core/src/config-compile.test.ts` includes multiple assertions that the compiled memory MCP environment uses `http://localhost:7700`, so tests currently preserve the historical local default and will need deliberate updates if the canonical local default changes.
- The same compile tests reveal an adjacent env-name inconsistency: compiled OpenCode config currently emits `MEILI_API_KEY`, while the memory MCP server reads `MEILI_MASTER_KEY`. This is a separate but highly relevant reliability gap because env-boundary cleanup should avoid preserving mismatched variable names.
- `tools/mcp-memory-server.integration.test.ts` defaults its own test probe to `process.env.MEILI_URL || "http://localhost:7701"`, which already matches the repo's active Docker Compose port rather than the broader codebase's older `7700` assumption. Test expectations are therefore split today between integration coverage favoring `7701` and config-compile coverage favoring `7700`.
- Discovery conclusion after this turn: the durable fix boundary is now clear enough to move into drafting. Shared config should remain the source of truth, OpenCode/MCP generation should compile from that source of truth, and Railway/CI should keep their explicit URLs while local behavior is normalized intentionally rather than by scattered fallbacks.

## Architecture Overview
- Local development path discovered this turn:
  OpenCode in `/Users/drewbie/dev/randal` -> symlinked `agent/opencode-config/opencode.json` -> local memory MCP process with injected `MEILI_URL` -> MCP server Meilisearch clients (`MeilisearchStore`, `MessageManager`, analytics store) -> local Meilisearch exposed by Docker Compose on host port `7701`.
- Parallel local write path discovered this turn:
  OpenCode plugin `agent/opencode-config/plugins/chat-history.ts` -> `process.env.MEILI_URL` if provided, otherwise local fallback `http://localhost:7700` -> direct document writes to Meilisearch index `messages-randal`.
- Adjacent platform default path discovered this turn:
  shared config schema in `packages/core/src/config.ts` -> default `memory.url=http://localhost:7700` -> any consumer that relies on config defaults without explicit env override inherits the old local assumption.
- Current coupling problem:
  local Docker port mapping has moved to `7701`, but three distinct layers still encode `7700`: OpenCode MCP env injection, plugin fallback logic, and shared core config / memory server defaults.
- Railway-separation implication:
  Railway connectivity should not depend on the local host-port convention at all. The clean boundary is to let Railway provide explicit env/config values while local development uses a clearly defined canonical env variable/default chain; otherwise local fallback changes risk bleeding into production assumptions.
- Compatibility implication for older local setups:
  because `7700` still appears to be the historical default across the codebase, the next phase should decide whether compatibility is preserved by env override precedence plus documentation, or by an explicit fallback chain that can tolerate both `7701` and legacy `7700` without obscuring failures.
- Shared runtime boundary refined this turn:
  `randal.config*.yaml` / shared config env interpolation -> `packages/core/src/config.ts` validated `memory.url` -> `packages/core/src/config-compile.ts` compiles that value into OpenCode memory MCP env `MEILI_URL` -> local MCP server uses that env for memory, chat summaries, and analytics.
- Shared runtime bootstrap path refined this turn:
  `packages/cli/src/commands/serve.ts` reads `config.memory.url`, probes `${url}/health`, and if needed auto-starts local Meilisearch. This means the config-level memory URL is not only a compile-time value; it also drives runtime startup behavior and must stay consistent with any chosen local default.
- Deployment separation now explicit:
  Railway config uses `${MEILISEARCH_URL:-http://127.0.0.1:7700}` and CI config uses `http://127.0.0.1:7700`, both with dedicated indexes. Those environments already declare their Meilisearch endpoint explicitly, so local cleanup should avoid weakening that explicitness.
- Test landscape now explicit:
  config compilation tests currently lock in `localhost:7700`, while MCP integration tests already prefer `localhost:7701`. Any fix that standardizes local behavior must reconcile these two expectations intentionally.
- Additional reliability concern discovered:
  the shared-config-to-MCP compilation layer currently appears to emit `MEILI_API_KEY`, while the memory server reads `MEILI_MASTER_KEY`. Even if the current bug is about port resolution, this mismatch belongs in the same architecture story because it affects the correctness of the env-driven boundary.
- Drafting decision for the build phase:
  treat shared `memory.url` as the canonical source of truth for compiled/runtime Randal flows, keep Railway and CI configs explicit and unchanged unless verification proves otherwise, and use explicit `MEILI_URL` overrides as the compatibility escape hatch for local setups that still want `localhost:7700`.
- Verification refinement from Turn 6:
  there are currently two memory MCP entrypoints in the repo: shared config compilation targets `tools/mcp-memory-server.ts`, while the checked-in local OpenCode config targets `tools/mcp-memory/index.ts`. The plan should therefore verify URL/auth consistency across both entrypoints or intentionally document why only one is in scope.

## Implementation Steps
1. Canonicalize the shared memory config/env boundary around the active local default and fix the Meilisearch auth env mismatch.
   Files: `packages/core/src/config.ts`, `packages/core/src/config-compile.ts`, `tools/mcp-memory-server.ts`, `packages/core/src/config-compile.test.ts`
   Depends on: discovery complete
   Actions:
   - Change the shared local default in `packages/core/src/config.ts` from `http://localhost:7700` to `http://localhost:7701` so validated config reflects the repo's actual local Docker entrypoint.
   - Keep `packages/core/src/config-compile.ts` sourcing `MEILI_URL` from `config.memory.url`, but change the emitted auth variable from `MEILI_API_KEY` to `MEILI_MASTER_KEY` so compiled OpenCode config matches what the memory MCP server actually reads.
   - In `tools/mcp-memory-server.ts`, update the local fallback URL to `http://localhost:7701` and intentionally support `MEILI_MASTER_KEY` as canonical while tolerating legacy `MEILI_API_KEY` as a backward-compatible fallback during migration.
   - Update `packages/core/src/config-compile.test.ts` comprehensively, not just one assertion: all `MEILI_API_KEY` expectations and local-default URL fixtures in the memory-MCP sections need to move to the new contract so Step 1 does not leave split test semantics behind.
   Verification:
   - `bun test packages/core/src/config-compile.test.ts`
   - `bun test tools/mcp-memory-server.integration.test.ts` with local Meilisearch running or `MEILI_URL=http://localhost:7701`
   - targeted env smoke check for auth migration: launch the memory server once with `MEILI_MASTER_KEY` and once with legacy `MEILI_API_KEY` to confirm the canonical variable works and the compatibility fallback remains functional during migration
   Done criteria:
   - Shared config defaults, compiled OpenCode memory env, and MCP runtime all resolve to the same canonical local URL by default.
   - Compiled auth env and runtime auth env names agree.
   - Legacy local setups can still force `localhost:7700` by setting `MEILI_URL` explicitly instead of relying on hidden fallback behavior.
   - No remaining compile-test assertion still encodes the superseded `MEILI_API_KEY` contract for the primary memory MCP path.
2. Align the checked-in local OpenCode entry points with the canonical local URL while preserving env override compatibility.
   Files: `agent/opencode-config/opencode.json`, `agent/opencode-config/plugins/chat-history.ts`
   Depends on: Step 1
   Actions:
   - Update the symlinked local OpenCode config in `agent/opencode-config/opencode.json` so the memory MCP no longer injects the broken `http://localhost:7700` value.
   - Update `agent/opencode-config/plugins/chat-history.ts` to use the same canonical local fallback (`http://localhost:7701`) while still honoring `process.env.MEILI_URL` first.
   - During implementation, explicitly confirm whether the checked-in OpenCode config should continue launching `tools/mcp-memory/index.ts` while compiled configs launch `tools/mcp-memory-server.ts`; if both entrypoints remain, verify that the URL/auth compatibility story is consistent across both rather than only fixing one.
   - Keep the compatibility story explicit: local `7701` is the repo default, but any developer still running Meilisearch on `7700` can opt in by exporting `MEILI_URL=http://localhost:7700` before launching OpenCode.
   Verification:
   - `opencode` session using the symlinked config, then exercise memory/chat-history calls and confirm the resolved target is `http://localhost:7701` unless `MEILI_URL` is overridden
   - if `tools/mcp-memory/index.ts` remains the actual OpenCode entrypoint, verify its startup path sees the same `MEILI_URL` / Meilisearch auth env contract as `tools/mcp-memory-server.ts`
   - `MEILI_URL=http://localhost:7700 opencode` smoke check for legacy local compatibility if a legacy instance is available
   Done criteria:
   - The immediate broken local OpenCode path in `/Users/drewbie/dev/randal` stops forcing `7700`.
   - Chat-history and memory MCP follow the same URL precedence and no longer drift by default.
   - The checked-in OpenCode memory command path is either intentionally preserved with matching behavior or intentionally updated, with no undocumented split between memory entrypoints.
3. Make local CLI bootstrap respect the same configured endpoint and lock the local-vs-explicit behavior into verification coverage.
   Files: `packages/cli/src/commands/serve.ts`, `tools/mcp-memory-server.integration.test.ts`
   Depends on: Step 1
   Actions:
   - Update `packages/cli/src/commands/serve.ts` so Meilisearch health checks and Docker fallback remain driven by `config.memory.url`, including deriving the Docker host port from the configured localhost/`127.0.0.1` URL instead of always publishing `7700:7700`.
   - Keep Railway/CI explicit by not changing `randal.config.railway.yaml` or `randal.config.ci.yaml`; the CLI logic should respect their declared URLs rather than re-imposing local defaults.
   - Tighten `tools/mcp-memory-server.integration.test.ts` so it documents and verifies the local default/override story clearly enough to catch future drift between local `7701` behavior and explicit env overrides.
   - Limit Docker host-port derivation to obvious localhost targets (`localhost` / `127.0.0.1`) and keep non-local URLs on the explicit-config path only; do not try to infer container publishing from Railway/private-network endpoints.
   Verification:
   - `bun test tools/mcp-memory-server.integration.test.ts`
   - targeted CLI smoke check using a config that omits `memory.url` and another that explicitly sets `http://127.0.0.1:7700`
   - negative-path smoke check using a clearly non-local URL (for example a Railway-style host) to confirm local Docker-port inference does not trigger for explicit remote endpoints
   Done criteria:
   - CLI auto-start no longer assumes Docker host port `7700` when the configured local endpoint is `7701`.
   - Explicit Railway/CI-style URLs continue to work unchanged.
   - Broader verification covers both the canonical local default and an explicit legacy override path.
   - CLI bootstrap logic does not misclassify remote/hosted Meilisearch URLs as local Docker targets.
4. Sync local setup/test/documentation surfaces that still encode the historical `7700` assumption.
   Files: `packages/cli/src/commands/init.ts`, `packages/core/src/config.test.ts`, `docs/cli-reference.md`
   Depends on: Steps 1-3
   Actions:
   - Update `packages/cli/src/commands/init.ts` so generated starter config and local Meilisearch detection/bootstrap use the same canonical local endpoint story as the rest of the system, rather than silently reintroducing `7700` in newly initialized projects.
   - Specifically cover all three stale local assumptions currently present in `init.ts`: `detectMeilisearch()` health probing, `ensureMeilisearch()` Docker port publishing, and `buildConfigYaml()`'s generated `memory.url` value.
   - Update `packages/core/src/config.test.ts` so schema default expectations match the chosen shared default.
   - Update `docs/cli-reference.md` example output so `randal doctor` documentation no longer advertises the stale local health URL.
   - Keep Railway/CI examples explicit and unchanged unless verification reveals a concrete mismatch; this step is for local setup/docs/test consistency, not for broad deployment churn.
   Verification:
   - `bun test packages/core/src/config.test.ts`
   - targeted `randal init` smoke check to confirm generated config uses the intended local memory URL and `MEILI_MASTER_KEY`
   - doc spot-check that the CLI reference example aligns with the verified doctor output after the change
   Done criteria:
   - Fresh local initialization no longer reintroduces a stale `7700` default.
   - Core config tests and CLI docs match the chosen canonical local behavior.
   - No remaining user-facing local setup surface contradicts the new compatibility story.
   - `init.ts` no longer disagrees internally between health detection, Docker bootstrap, and emitted config defaults.

5. Guard remote Meilisearch serve paths from local key mutation side effects.
   Files: `packages/cli/src/commands/serve.ts`
   Depends on: Step 3
   Actions:
   - Move the `localTarget` / localhost-only gate ahead of any `MEILI_MASTER_KEY` generation or `.env` persistence so explicit remote Meilisearch URLs do not get mutated as if they were local bootstrap targets.
   - Preserve the local bootstrap behavior added in Step 3 for canonical `http://localhost:7701` and explicit legacy localhost overrides, but leave remote / Railway-style endpoints completely untouched.
   Verification:
   - targeted `randal serve` smoke check with a non-local `memory.url` confirming no new `MEILI_MASTER_KEY` is generated or persisted
   - rerun the Step 3 negative-path smoke check for a Railway-style host
   Done criteria:
   - `randal serve` does not generate or persist a new local `MEILI_MASTER_KEY` when `memory.url` points at a non-local Meilisearch endpoint.
   - Remote / Railway-style configurations remain behaviorally unchanged while localhost flows still work as designed.

## Sprint Contract

| Step | Done Criteria | Verified |
|------|--------------|----------|
| 1 | Shared config default, compiled OpenCode env, and memory MCP runtime all use one canonical local URL; auth env naming is consistent with a documented compatibility fallback. | `bun test packages/core/src/config-compile.test.ts`; `bun test tools/mcp-memory-server.integration.test.ts`; auth-env migration smoke check (`MEILI_MASTER_KEY` and legacy `MEILI_API_KEY`) |
| 2 | Symlinked local OpenCode memory and chat-history paths stop hardcoding broken `7700` and share the same URL precedence. | Local `opencode` smoke check with default local config; verify actual OpenCode memory entrypoint behavior; optional `MEILI_URL=http://localhost:7700 opencode` compatibility smoke check |
| 3 | CLI bootstrap honors configured local host port and does not disturb explicit Railway/CI URLs. | `bun test tools/mcp-memory-server.integration.test.ts`; targeted `randal serve` smoke checks against default and explicit configs; non-local URL negative-path smoke check |
| 4 | Init-generated config, core config default tests, and CLI docs all reflect the canonical local URL and compatibility story. | `bun test packages/core/src/config.test.ts`; targeted `randal init` smoke check; CLI reference spot-check |
| 5 | Explicit non-local Meilisearch URLs are left completely untouched by `randal serve`, including `.env` key persistence. | targeted `randal serve` smoke check with non-local `memory.url`; Railway-style negative-path smoke check |

## Files to Modify
| File | Action | Step | Summary |
|------|--------|------|---------|
| `packages/core/src/config.ts` | Update | 1 | Change the shared local default `memory.url` to the repo's active local port `http://localhost:7701`. |
| `packages/core/src/config-compile.ts` | Update | 1 | Keep `MEILI_URL` compiled from shared config and emit canonical `MEILI_MASTER_KEY` instead of `MEILI_API_KEY`. |
| `tools/mcp-memory-server.ts` | Update | 1 | Change the fallback URL to `7701` and intentionally support legacy auth env compatibility during migration. |
| `packages/core/src/config-compile.test.ts` | Update | 1 | Reconcile compile-time expectations with the new canonical local URL and auth env contract. |
| `agent/opencode-config/opencode.json` | Update | 2 | Remove the broken local `7700` injection so the symlinked OpenCode workflow targets the working local instance by default. |
| `agent/opencode-config/plugins/chat-history.ts` | Update | 2 | Align chat-history fallback/precedence with the canonical local URL and env override story. |
| `packages/cli/src/commands/serve.ts` | Update | 3 | Make Meilisearch bootstrap derive localhost Docker publish behavior from configured `memory.url` instead of hardcoded `7700`. |
| `tools/mcp-memory-server.integration.test.ts` | Update | 3 | Encode the intended local-default and explicit-override behavior in integration coverage. |
| `packages/cli/src/commands/init.ts` | Update | 4 | Prevent freshly initialized local projects from regenerating the stale `7700` default in detection, bootstrap, and generated config output. |
| `packages/core/src/config.test.ts` | Update | 4 | Align shared schema default assertions with the chosen canonical local URL. |
| `docs/cli-reference.md` | Update | 4 | Update the documented doctor output so user-facing CLI docs match the verified local Meilisearch URL. |
| `packages/cli/src/commands/serve.ts` | Update | 5 | Prevent remote/hosted Meilisearch configs from generating or persisting a local `MEILI_MASTER_KEY`. |

## Dependencies / Prerequisites
- Local Meilisearch availability and chosen canonical resolution strategy.
- Confirmation of how OpenCode config should source Meilisearch URL for local vs Railway contexts.
- Decision on whether local compatibility with historical `localhost:7700` remains supported automatically or only via explicit env/config override.
- Decision on the canonical source of truth for local Meilisearch URL: checked-in local config, shared config default, `.env` / process env override, or a documented precedence chain across those layers.
- Decision on whether the env variable contract around Meilisearch auth should also be normalized while touching the same boundary.
- Chosen drafting position: canonical local default becomes `http://localhost:7701`; compatibility for `7700` is preserved via explicit `MEILI_URL` override rather than dual hidden URL fallbacks.

## Risks / Considerations
- Local and Railway defaults may currently be coupled in more places than the immediate OpenCode config.
- A naive hardcoded switch to `7701` could fix one workflow while regressing setups that still expect `7700`.
- Tests and docs may encode older assumptions that need to stay aligned with runtime behavior.
- Fixing only `agent/opencode-config/opencode.json` would likely leave chat-history plugin fallbacks and shared config defaults drifting, creating future regressions or confusing mixed behavior.
- Changing the shared `packages/core` default alone would not help if OpenCode continues injecting `MEILI_URL=http://localhost:7700` into the MCP process.
- `serve.ts` currently bootstraps local Meilisearch using the shared config URL but falls back to Docker port `7700`, so partial fixes could leave CLI startup behavior inconsistent with repo-local Compose behavior.
- Railway and CI configs are already explicit and stable; changing them unnecessarily would blur the clean boundary instead of improving it.
- Updating local URL defaults without reconciling compile/integration tests will produce noisy failures that obscure whether the runtime behavior actually improved.
- Touching the env-driven boundary without addressing the apparent `MEILI_API_KEY` vs `MEILI_MASTER_KEY` mismatch risks leaving another silent configuration defect in place.
- If `agent/opencode-config/opencode.json` remains a hand-maintained artifact rather than a compiled output, future drift is still possible unless its relationship to shared config is made explicit in docs or tooling.
- Deriving Docker publish behavior from `memory.url` must be limited to obvious localhost targets so explicit Railway/private-network URLs are never misinterpreted as local container ports.
- There are two memory MCP entrypoints in active use (`tools/mcp-memory-server.ts` and `tools/mcp-memory/index.ts`); fixing defaults in only one would leave the local OpenCode path and the compiled config path behaviorally split.
- `packages/core/src/config-compile.test.ts` contains multiple `MEILI_API_KEY` and `localhost:7700` assertions, so Step 1 needs a broad test sweep, not a surgical one-line update.

## Rollback Plan
- Revert the branch or restore the previous Meilisearch URL resolution behavior if the new strategy causes regressions.

## Acceptance Criteria
- [x] Local OpenCode memory/chat-history no longer fails because of an incorrect default connection target.
- [x] Railway-oriented memory configuration still resolves correctly.
- [x] The chosen configuration strategy is documented and test-covered enough to prevent silent drift.
- [x] Fresh local CLI initialization and bootstrap flows no longer reintroduce stale `7700` assumptions.
- [x] Both active memory MCP entrypoints follow the same resolved Meilisearch URL/auth contract, or the obsolete one is intentionally removed from the path.
- [x] Relevant targeted tests pass.
- [x] Broader validation passes for touched areas.
- [x] No remaining local setup/test/doc surface still advertises the superseded default `http://localhost:7700` unless it is an intentional explicit-override example.
- [x] `randal serve` leaves explicit non-local Meilisearch configs untouched, including `.env` key persistence.

## Build Notes
- Reserved for @build.
- Step 1 completed in iteration 1. Branch: fix/local-meili-memory-port
- Shared config default now uses `http://localhost:7701`, compiled memory MCP auth uses canonical `MEILI_MASTER_KEY`, and `tools/mcp-memory-server.ts` accepts legacy `MEILI_API_KEY` only as an explicit compatibility fallback.
- Verification: `bun test packages/core/src/config-compile.test.ts` (74 pass), `bun test tools/mcp-memory-server.integration.test.ts` (4 pass), plus targeted MCP initialize smoke checks with `MEILI_MASTER_KEY` and legacy `MEILI_API_KEY`.
- Step 2 completed in iteration 2. Branch: fix/local-meili-memory-port
- Adapted scope beyond the original file list because the checked-in OpenCode config still launches `tools/mcp-memory/index.ts`; updated `tools/mcp-memory/types.ts` and `tools/mcp-memory/init.ts` so both active memory entrypoints now share the same `MEILI_URL`/auth fallback contract.
- Verification: targeted smoke checks confirmed `agent/opencode-config/opencode.json` now passes through env-driven `MEILI_URL`/auth values instead of hardcoding `:7700`, `agent/opencode-config/plugins/chat-history.ts` defaults to `http://localhost:7701` and honors explicit `MEILI_URL=http://localhost:7700`, and the shared `tools/mcp-memory` env resolution now defaults to `http://localhost:7701` while accepting legacy `MEILI_API_KEY`.
- Step 3 completed in iteration 3. Branch: fix/local-meili-memory-port
- `packages/cli/src/commands/serve.ts` now derives local Meilisearch startup settings from explicit localhost-style URLs only: canonical local `http://localhost:7701` publishes `7701:7700`, explicit legacy `http://127.0.0.1:7700` still publishes `127.0.0.1:7700:7700`, and non-local URLs skip local auto-start instead of being misclassified.
- Verification: `bun test tools/mcp-memory-server.integration.test.ts` (8 pass after adding local-resolution coverage) and targeted `resolveLocalMeilisearchTarget()` smoke checks for canonical local, explicit legacy local, and remote-hosted endpoints.
- Step 4 completed in iteration 4. Branch: fix/local-meili-memory-port
- Adapted scope beyond the original file list to clear the remaining stale local-default surfaces found during the final sweep: updated `packages/memory` and runner tests, local example configs, and docs/config reference pages that still advertised `http://localhost:7700` as the default.
- Verification: `bun test packages/core/src/config.test.ts` (48 pass), `bun test packages/memory/src/memory.test.ts packages/memory/src/stores/meilisearch.test.ts packages/memory/src/cross-agent.test.ts tests/integration/cross-agent-sharing.test.ts packages/runner/src/prompt-assembly.test.ts` (113 pass), and an isolated `randal init --yes` smoke run showing generated config now uses `memory.url: http://localhost:7701` with `apiKey: "${MEILI_MASTER_KEY}"`.
- Final sweep: the only remaining `http://localhost:7700` references are intentional legacy-override examples/tests (`tools/mcp-memory-server.integration.test.ts` and `agent/README.md`).
- Final review finding: `packages/cli/src/commands/serve.ts` still generated/persisted a new local `MEILI_MASTER_KEY` before checking whether `memory.url` was actually local, which risks mutating remote / Railway-style setups. Reopened the build with Step 5 to guard the non-local path.
- Step 5 completed in iteration 5. Branch: fix/local-meili-memory-port
- Moved the localhost-only gate in `packages/cli/src/commands/serve.ts` ahead of any local `MEILI_MASTER_KEY` generation or `.env` persistence so explicit remote / Railway-style Meilisearch URLs now return untouched.
- Verification: targeted `ensureMeilisearch()` smoke check with `memory.url: https://meili.internal:7700` confirmed no `.env` mutation and no generated local key when `MEILI_MASTER_KEY`/`MEILI_API_KEY` start empty; reran `resolveLocalMeilisearchTarget()` negative-path smoke to confirm Railway-style hosts still bypass local inference while canonical `http://localhost:7701` remains local.

## Planning Progress
- [x] Requirements gathered (Turn 1)
- [x] Discovery (Turn 2-3)
- [x] Drafting (Turn 4-5)
- [x] Verification (Turn 6-7: all steps reviewed and tightened)

PLAN_PROGRESS: Phase: Ready | Turn: 7/~7 | Steps: 4/4
