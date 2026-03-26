# Plan: Evaluator Evolution — Adaptive QA, Sprint Contracts, and Architecture Cleanup

**Created**: 2026-03-26T20:00:00Z
**File**: .opencode/plans/evaluator-evolution_20260326_200000.plan.md
**Status**: Ready
**Planning Turn**: 5 of 5
**Model**: anthropic/claude-opus-4-6

## Summary

Evolve Randal's build/review architecture to incorporate four patterns from Anthropic's long-running harness research (March 2026): (1) an adaptive evaluator that interacts with build outputs, not just reads diffs, (2) sprint contracts for pre-build quality negotiation, (3) pivot-or-refine strategic decisions after evaluation, and (4) model-adaptive context strategy. Additionally, remove Claude Code and Codex adapter support, establishing OpenCode as the sole agent CLI.

## Requirements

1. **Adaptive Evaluator Protocol**: The Full-Spectrum Review in build.md must evolve from diff-only code review to domain-aware evaluation that interacts with build outputs. Evaluator mode is inferred from plan step domain tags:
   - `[frontend]`, `[ui]`, `[design]` → **Visual QA**: Start the app, use steer (or Playwright MCP if available) to navigate, screenshot, interact, grade UI states
   - `[backend]`, `[api]`, `[database]` → **Functional QA**: Hit API endpoints, check database state, run integration tests
   - `[docs]`, `[content]`, `[marketing]` → **Content Review**: Read output artifacts, grade for clarity, tone, completeness
   - `[config]`, `[ci]`, `[devops]`, `[infrastructure]` → **Operational QA**: Run config, validate pipeline, check deployment
   - `[testing]` → **Test Quality Review**: Review coverage, run test suite, check for flaky/shallow tests
   - Mixed/unclear → **Code Review only**: Current Full-Spectrum Review behavior (read diff, apply lens checklists)

2. **Recursive Feedback Loop**: After evaluator grades the output, findings feed back as fix-steps → @build fixes → evaluator re-grades → repeat until quality threshold met or max iterations reached.

3. **Sprint Contracts**: Before @build starts a batch of steps, Randal dispatches a contract negotiation:
   - @build reads next N steps, writes specific testable "done" criteria for each
   - Sprint contract written to plan file under each step or in a dedicated section
   - Optional: review agent validates the contract before building begins

4. **Pivot-or-Refine Strategy**: After evaluation feedback, @build outputs a strategic assessment:
   - **Refine**: Scores trending well, fix specific issues
   - **Partially rework**: Approach is mostly right but needs significant changes to one component
   - **Pivot**: Fundamental approach isn't working, try different architecture
   - This extends the existing `[!] NEEDS_REDESIGN` marker to a spectrum

5. **Model-Adaptive Context Strategy**: Enhance model-context.ts to return:
   - `context_strategy: "reset" | "compact"` — whether to use full context resets or compaction
   - `session_length: "short" | "medium" | "long"` — how long a session the model can sustain
   - Randal uses these when dispatching subagents (more aggressive resets for context-anxious models)

6. **Remove Claude Code and Codex**: Delete the adapter files and all references:
   - Delete `packages/runner/src/agents/claude-code.ts` and its test
   - Delete `packages/runner/src/agents/codex.ts` and its test
   - Update `packages/runner/src/agents/index.ts` to only export opencode + mock
   - Update README.md to position OpenCode as the sole supported agent
   - Remove references to Claude Code and Codex throughout docs

7. **Playwright MCP as Optional Evaluator Tool**: Consider adding Playwright MCP server configuration as an optional evaluator capability for web app QA. Steer remains primary for native macOS + desktop. Playwright MCP for headless web testing, CI environments, cross-platform.

8. **Evaluator Must Be Adversarial**: The evaluator should be explicitly prompted to be skeptical — look for what breaks, not what works. Per Anthropic's finding: "tuning a standalone evaluator to be skeptical is far more tractable than making a generator critical of its own work."

## Constraints

- All brain changes go in `agent/` directory (agents and tools)
- Plan file template changes affect `plan.md`
- Build protocol changes affect `build.md`
- Orchestration changes affect `randal.md`
- model-context changes affect `agent/tools/model-context.ts`
- Harness runner changes affect `packages/runner/src/`
- Steer and drive skill files should not need changes (they're tool docs, not protocol)
- Must maintain the existing context budget system — new features work within it
- The evaluator protocol must gracefully degrade: if steer unavailable → programmatic checks only; if Playwright MCP unavailable → steer or curl-based; if no GUI tools → code review only

## Discovery Log

### Turn 1 — Discovery (6 files read)

**Files read**: `agent/agents/build.md`, `agent/agents/randal.md`, `agent/agents/plan.md`, `agent/tools/model-context.ts`, `packages/runner/src/agents/index.ts`, `packages/runner/src/agents/` (directory listing)

#### build.md (371 lines)
- **Full-Spectrum Review Mode**: Lines 297-371. Currently diff-only code review triggered when dispatch says "REVIEW MODE". Reads git diff, applies 8 lens checklists (Architect, Crafter, Strategist, Auditor, Narrator, Diplomat, Provocateur, Catalyst), outputs findings by severity.
- **Review output format**: Lines 315-348. Structured `REVIEW:` header + box with findings grouped by severity.
- **NEEDS_REDESIGN marker**: Line 96. Current binary — step marked `[!] NEEDS_REDESIGN` and checkpoint immediately. This is what pivot-or-refine replaces with a spectrum.
- **Checkpoint output format**: Lines 228-296. `PROGRESS:` header + box. This needs a new `Strategy:` field for pivot-or-refine.
- **What is NOT a Finding**: Lines 358-363. Good guardrails to preserve.
- **Key insertion points**:
  - After line 296 (before "## Full-Spectrum Review Mode"): Insert new "## Adaptive Evaluator Protocol" section
  - Lines 297-371 (Full-Spectrum Review): Evolve into a subsection of the new evaluator protocol, becoming the "Code Review" fallback mode
  - Line 93-96 (NEEDS_REDESIGN handling): Extend to pivot-or-refine spectrum
  - Line 232-264 (checkpoint format): Add `Strategy: refine|rework|pivot` field

#### randal.md (652 lines)
- **Build Pipeline**: Lines 203-268. Dispatch @build → parse PROGRESS → report → update loop-state → re-invoke. This is the loop that needs sprint contract injection.
- **Full-Spectrum Review dispatch**: Lines 530-541. After @build completes, Randal dispatches review pass. Steps: get diff, construct review prompt with all lens checklists, dispatch @build in review mode, parse findings, add fix-steps for Critical/High. This is the integration point for the adaptive evaluator — Randal must also pass domain tags so the evaluator knows which mode to use.
- **Capability Discovery**: Lines 481-487. Randal probes for steer/drive/memory and passes availability to subagents. This is where Playwright MCP probing would go.
- **loop-state.json schema**: Lines 354-393. Needs new fields for sprint contract state and evaluator iteration count.
- **Key insertion points**:
  - After line 202 (before Build Pipeline step 1): Insert sprint contract phase (Phase 0.5: Contract Negotiation)
  - Lines 530-541 (Full-Spectrum Review dispatch): Replace with adaptive evaluator dispatch that reads domain tags and selects evaluator mode
  - Lines 481-487 (Capability Discovery): Add Playwright MCP probing
  - Lines 354-393 (loop-state schema): Add `sprint_contract`, `eval_iterations`, `eval_strategy` fields
  - Lines 303-331 (Error Handling): Integrate pivot-or-refine — replace `NEEDS_REDESIGN` handling with strategy spectrum

#### plan.md (257 lines)
- **Plan File Template**: Lines 176-248. This is the canonical template that @plan uses when creating plans. Needs a `## Sprint Contract` section added to the template.
- **Domain tags**: Lines 105. Already documented — `[backend]`, `[frontend]`, etc. Used by Randal to select cognitive lens. The same tags will drive evaluator mode selection. No change needed here — tags already exist.
- **Step structure**: Lines 208-214. Each step has Action, File, Details, Depends on, Verify, checkbox. Sprint contract adds "Done Criteria" to each step.
- **Key insertion points**:
  - Lines 208-214 (step template): Add `- **Done Criteria**: {testable acceptance criteria for this specific step}` field
  - Lines 176-248 (plan file template): Add `## Sprint Contract` section between Implementation Steps and Files to Modify

#### model-context.ts (150 lines)
- **calculate() function**: Lines 64-123. Returns JSON with model name, context_limit, output_limit, effective_window, tier (1/2/3), budget (build_steps_per_invocation, plan_files_per_discovery_turn, plan_steps_per_drafting_turn), cost, note.
- **Tier classification**: Line 81. `tier = contextLimit >= 128000 ? 1 : contextLimit >= 48000 ? 2 : 3`
- **fallback() function**: Lines 125-150. Returns same shape with Tier 2 defaults.
- **Key insertion points**:
  - Lines 95-122 (return object in calculate): Add `context_strategy` and `session_length` fields derived from tier
  - Lines 125-150 (fallback return): Add same fields with defaults
  - Tier 1 (128K+): `context_strategy: "compact"`, `session_length: "long"` — large models can compact context
  - Tier 2 (48K-128K): `context_strategy: "reset"`, `session_length: "medium"` — medium models should reset
  - Tier 3 (<48K): `context_strategy: "reset"`, `session_length: "short"` — small models need aggressive resets

#### packages/runner/src/agents/index.ts (40 lines)
- **Imports**: Lines 1-5. Imports all 4 adapters: claudeCode, codex, mock, opencode.
- **Adapter registry**: Lines 9-14. `adapters` dict maps names to adapters.
- **Exports**: Lines 37-40. Named exports for all 4.
- **Cleanup needed**: Remove lines 2-3 (claude-code, codex imports), remove dict entries on lines 11-12, remove exports on lines 38-39.
- **Files to delete**: `claude-code.ts`, `claude-code.test.ts`, `codex.ts`, `codex.test.ts` (confirmed all exist in directory listing)

#### packages/runner/src/agents/ (directory)
- Contains: `adapter.ts`, `claude-code.test.ts`, `claude-code.ts`, `codex.test.ts`, `codex.ts`, `index.ts`, `mock.ts`, `opencode.test.ts`, `opencode.ts`
- After cleanup: `adapter.ts`, `index.ts`, `mock.ts`, `opencode.test.ts`, `opencode.ts`

## Architecture Overview

### Current Flow (Before)

```
User request → Randal → @plan (multi-turn) → Plan file
                      → @build (build mode, N steps) → commits
                      → @build (review mode, diff-only) → findings
                      → if Critical/High: add fix-steps → @build again
                      → repeat until done
```

Review is a single pass, diff-only, using 8 lens checklists. The evaluator reads code but never interacts with build outputs (doesn't start apps, hit endpoints, or take screenshots).

### New Flow (After)

```
User request → Randal → @plan (multi-turn) → Plan file (with Done Criteria per step)
                      → Sprint Contract: @build reads next N steps, writes testable done criteria
                      → @build (build mode, N steps) → commits
                      → Adaptive Evaluator (mode selected from domain tags):
                        ├── [frontend/ui] → Visual QA (steer or Playwright MCP)
                        ├── [backend/api] → Functional QA (curl, test suite, DB checks)
                        ├── [docs/content] → Content Review (read artifacts, grade)
                        ├── [config/ci]   → Operational QA (run config, validate)
                        ├── [testing]     → Test Quality Review (coverage, flaky check)
                        └── [mixed/none]  → Code Review (current lens-based review)
                      → Evaluator grades output (adversarial stance)
                      → Pivot-or-Refine decision:
                        ├── Refine: fix specific issues → @build fixes → re-evaluate
                        ├── Partially Rework: significant changes to one component
                        └── Pivot: fundamental approach wrong → redesign
                      → Recursive loop (max 3 iterations) until quality threshold
                      → repeat until done
```

### Key Architectural Decisions

1. **Evaluator mode inference**: Domain tags already exist on plan steps (documented in plan.md:105). Randal reads the tags on the steps just built and selects the evaluator mode. No new tagging system needed.

2. **Graceful degradation chain**: Visual QA → programmatic QA → code review. If steer unavailable, skip screenshots. If Playwright MCP unavailable, use curl. If nothing, fall back to current code review. Each mode has a degraded version.

3. **Sprint contracts live in the plan file**: Added as `Done Criteria` on each step. No separate file. The contract is written by @build before building starts (a "contract negotiation" dispatch).

4. **Pivot-or-refine extends NEEDS_REDESIGN**: The existing binary `[!] NEEDS_REDESIGN` becomes a spectrum. The checkpoint output format gains a `Strategy:` field. Randal reads the strategy to decide next action.

5. **Model-adaptive context**: New fields in model-context.ts return object. `context_strategy` tells Randal whether to use full resets (kill session, re-invoke) or compaction (summarize, continue). `session_length` suggests how many turns a session can sustain.

6. **Adapter cleanup is isolated**: Deleting claude-code and codex adapters only touches `packages/runner/src/agents/`. No agent brain files reference them. Clean cut.

### Dependency Map Between Changes

```
model-context.ts changes (independent — no deps)
   ↓ (consumed by)
randal.md context strategy dispatch logic

plan.md template changes (independent)
   ↓ (consumed by)
randal.md sprint contract dispatch logic
build.md contract negotiation mode

build.md evaluator protocol (depends on plan.md domain tags — already exist)
   ↓ (consumed by)
randal.md evaluator dispatch logic

build.md pivot-or-refine (depends on evaluator protocol)
   ↓ (consumed by)
randal.md strategy handling in build loop

adapter cleanup (fully independent of all brain changes)
README update (depends on adapter cleanup)
```

### Recommended Step Ordering

1. model-context.ts — add context_strategy + session_length (independent, small)
2. plan.md — add Done Criteria field and Sprint Contract section to template (independent, small)
3. build.md — add Adaptive Evaluator Protocol section with all 6 modes (large, core change)
4. build.md — add Sprint Contract Negotiation mode (depends on plan.md template)
5. build.md — extend checkpoint format with Strategy field for pivot-or-refine (depends on evaluator)
6. build.md — extend NEEDS_REDESIGN to pivot-or-refine spectrum (depends on strategy field)
7. randal.md — add sprint contract dispatch to Build Pipeline (depends on build.md contract mode)
8. randal.md — replace Full-Spectrum Review dispatch with Adaptive Evaluator dispatch (depends on build.md evaluator)
9. randal.md — add pivot-or-refine handling to build loop error handling (depends on build.md strategy)
10. randal.md — add context_strategy usage to dispatch logic (depends on model-context.ts)
11. randal.md — add Playwright MCP to capability discovery (small addition)
12. Delete claude-code.ts, claude-code.test.ts, codex.ts, codex.test.ts (independent)
13. Update index.ts — remove claude-code/codex imports and exports (depends on deletions)
14. Update README.md — position OpenCode as sole agent (depends on adapter cleanup)

## Implementation Steps

### Step 1: Add context_strategy and session_length to model-context.ts [config]
- **Action**: modify
- **File**: `agent/tools/model-context.ts`
- **Details**: Add two new fields to the return object in `calculate()` (lines 95-122) and `fallback()` (lines 125-150):
  1. `context_strategy: "reset" | "compact"` — In `calculate()`, set based on tier: Tier 1 (`contextLimit >= 128000`) gets `"compact"`, Tiers 2-3 get `"reset"`. In `fallback()`, default to `"reset"`.
  2. `session_length: "short" | "medium" | "long"` — Tier 1 → `"long"`, Tier 2 → `"medium"`, Tier 3 → `"short"`. Fallback → `"medium"`.
  
  Insert after the `note` field (line 118) in calculate's return, before the closing `}`:
  ```typescript
  context_strategy: tier === 1 ? "compact" : "reset",
  session_length: tier === 1 ? "long" : tier === 2 ? "medium" : "short",
  ```
  
  Insert after the `warning` field (line 145) in fallback's return:
  ```typescript
  context_strategy: "reset",
  session_length: "medium",
  ```
- **Done Criteria**: `calculate()` returns JSON with `context_strategy` and `session_length` fields. Tier 1 returns `compact`/`long`, Tier 2 returns `reset`/`medium`, Tier 3 returns `reset`/`short`. `fallback()` returns `reset`/`medium`.
- **Depends on**: None
- **Verify**: `npx tsx -e "import('./agent/tools/model-context.ts')"` — or read the file back and confirm both functions include the new fields in correct positions.
- **Verified**: ✅ Line numbers confirmed accurate (calculate: 95-122, fallback: 125-150). Insertion points inside JSON.stringify objects correct. Backward compatible — adding fields to serialized JSON doesn't break existing consumers.
- [x] done

### Step 2: Add Done Criteria field and Sprint Contract section to plan.md template [docs]
- **Action**: modify
- **File**: `agent/agents/plan.md`
- **Details**: Two changes to the plan file template (lines 176-248):
  
  **Change A** — Add `Done Criteria` field to step template. Insert after the `Verify` line (line 213), before the checkbox:
  ```markdown
  - **Done Criteria**: {Testable acceptance criteria — what must be true when this step is done}
  ```
  
  **Change B** — Add `Sprint Contract` section to the plan template. Insert between `## Implementation Steps` / step template block and `## Files to Modify` (between lines 216 and 218):
  ```markdown
  ## Sprint Contract
  {Written by @build before building a batch. Contains testable done criteria negotiated for each step in the upcoming sprint. Left empty during planning — populated during build pipeline.}
  
  | Step | Done Criteria | Verified |
  |------|--------------|----------|
  | {n} | {specific testable criterion} | [ ] |
  ```
- **Done Criteria**: The plan.md template includes both a `Done Criteria` field in the step structure and a `## Sprint Contract` section between Implementation Steps and Files to Modify.
- **Depends on**: None
- **Verify**: Read `agent/agents/plan.md` and confirm both additions are present in the template.
- **Verified**: ✅ Line numbers confirmed accurate (step template: 208-214, Verify on 213, checkbox on 214). Sprint Contract section insertion between lines 216 and 218 (after step examples, before Files to Modify) is correct.
- [x] done

### Step 3: Add Adaptive Evaluator Protocol (FUNCTIONAL REVIEW MODE) to build.md [backend]
- **Action**: modify
- **File**: `agent/agents/build.md`
- **Details**: Add a new `## Functional Review Mode` section after the existing `## Full-Spectrum Review Mode` section (after line 363, before `## What You Do NOT Do` at line 364). This is the largest change. The section defines:
  
  **Structure**:
  ```markdown
  ## Functional Review Mode
  
  When dispatched in **functional review mode** (your dispatch prompt will say "FUNCTIONAL REVIEW MODE" with domain tags), you go beyond reading diffs — you interact with build outputs.
  
  ### Evaluator Stance
  
  You are an **adversarial evaluator**. Your job is to find what breaks, not confirm what works. Be skeptical of all outputs. Per Anthropic's finding: tuning a standalone evaluator to be skeptical is far more tractable than making a generator critical of its own work.
  
  - Assume every feature has an unhandled edge case
  - Assume every UI state has a broken variant
  - Assume every API endpoint can be called with bad input
  - Try to break things before confirming they work
  
  ### Domain-Tag-to-Mode Mapping
  
  The dispatch prompt includes domain tags from the plan steps that were just built. Select your evaluator mode:
  
  | Domain Tags | Evaluator Mode | Protocol |
  |-------------|---------------|----------|
  | `[frontend]`, `[ui]`, `[design]` | **Visual QA** | Start the app, navigate with steer (or Playwright MCP), screenshot key states, interact with forms/buttons, grade against design requirements |
  | `[backend]`, `[api]`, `[database]` | **Functional QA** | Hit API endpoints with curl/fetch, check response codes and payloads, verify database state, run integration tests |
  | `[docs]`, `[content]`, `[marketing]` | **Content Review** | Read output artifacts, grade for clarity/tone/completeness, check links, verify formatting |
  | `[config]`, `[ci]`, `[devops]`, `[infrastructure]` | **Operational QA** | Run config validation, check pipeline definitions, verify environment setup, test deployment scripts |
  | `[testing]` | **Test Quality Review** | Run the test suite, check coverage, identify flaky/shallow tests, verify assertions are meaningful |
  | Mixed or no tags | **Code Review Only** | Fall back to Full-Spectrum Review Mode above |
  
  ### Graceful Degradation
  
  Each mode has a degradation chain. If a tool is unavailable, fall back:
  
   - **Visual QA**: steer available → use steer see/click/type. Playwright MCP available → use playwright. Neither → run the app and check logs + curl HTML responses. Nothing → code review only. **Edge case**: If the app fails to start, log the startup error as a Critical finding and fall back to code review only.
  - **Functional QA**: curl/fetch → check responses. Test suite → run it. Database → query it. Nothing available → code review only.
  - **Content Review**: Read the files directly. No degradation needed.
  - **Operational QA**: Run the commands. If destructive (deploy), dry-run only. If no dry-run → code review only.
  - **Test Quality Review**: Run test suite and analyze output. If tests can't run → review test code statically.
  
  ### Visual QA Protocol
  
  1. Start the application (if not already running)
  2. Navigate to the affected pages/components
  3. Screenshot each key state (default, loading, error, empty, overflow)
  4. Interact: click buttons, fill forms, resize viewport
  5. Grade: Does it match requirements? Does it break on edge cases?
  6. Check: Accessibility (labels, focus order, contrast), responsiveness, error states
  
  ### Functional QA Protocol
  
  1. Identify the endpoints or functions modified
  2. Call them with valid inputs — verify correct responses
  3. Call them with invalid inputs — verify error handling
  4. Call them with edge cases (empty strings, huge payloads, unicode, special chars)
  5. Check side effects: database writes, file creation, event emission
  6. Run existing integration tests if available
  
  ### Content Review Protocol
  
  1. Read all output artifacts (docs, markdown, config files, templates)
  2. Grade: clarity (could a new developer understand this?), completeness (all sections filled?), tone (consistent with project?), accuracy (code examples actually work?)
  3. Check: links resolve, formatting renders correctly, no placeholder text left
  
  ### Operational QA Protocol
  
  1. Run config validation commands (lint, schema validate, dry-run)
  2. Check: environment variables documented, secrets not hardcoded
  3. Verify: CI pipeline syntax is valid, deployment scripts have rollback
  4. Test: configuration changes actually take effect (not just syntactically valid)
  
  ### Test Quality Review Protocol
  
  1. Run the full test suite
  2. Check coverage: are new code paths tested?
  3. Identify shallow tests: assertions that only check "no error" without verifying behavior
  4. Identify flaky tests: tests that depend on timing, ordering, or external state
  5. Verify: test descriptions match what they actually test
  6. Check: edge cases covered (null, empty, boundary values, concurrent access)
  
  ### Functional Review Output Format
  
  ```
  FUNCTIONAL_REVIEW: {mode} | {total_findings} findings | Pass: {pass_count}/{total_checks}
  
  ╔══════════════════════════════════════════════════════════════╗
  ║  🧪 FUNCTIONAL REVIEW                         @build · {model}║
  ╠══════════════════════════════════════════════════════════════╣
  ║                                                              ║
  ║  Mode: {Visual QA|Functional QA|Content Review|...}          ║
  ║  Domain Tags: {tags from dispatch}                           ║
  ║  Steps Evaluated: {step_range}                               ║
  ║  Tools Used: {steer|playwright|curl|test suite|...}          ║
  ║                                                              ║
  ║  ✅ Passed Checks:                                           ║
  ║     {check description}                                      ║
  ║     {check description}                                      ║
  ║                                                              ║
  ║  Critical ({n}):                                             ║
  ║    {file_or_endpoint}:{detail} — {finding}                   ║
  ║    Reproduction: {how to trigger}                            ║
  ║    Fix: {specific recommendation}                            ║
  ║                                                              ║
  ║  High ({n}):                                                 ║
  ║    {finding with reproduction steps}                         ║
  ║                                                              ║
  ║  Medium ({n}):                                               ║
  ║    {finding}                                                 ║
  ║                                                              ║
  ║  Low ({n}):                                                  ║
  ║    {finding}                                                 ║
  ║                                                              ║
  ║  Strategy: {Refine|Partially Rework|Pivot}                   ║
  ║  Rationale: {1-2 sentences on why this strategy}             ║
  ╚══════════════════════════════════════════════════════════════╝
  ```
  
  ### Recursive Feedback Loop
  
  After outputting findings, if Critical or High issues exist:
  1. Randal will add fix-steps to the plan and re-dispatch @build to fix them
  2. After fixes, Randal re-dispatches @build in functional review mode again
  3. This repeats until: all Critical/High resolved, OR max iterations reached (default: 3)
  4. On each iteration, reference prior findings to verify they're actually fixed
  ```
- **Done Criteria**: build.md contains a `## Functional Review Mode` section with: adversarial evaluator stance, domain-tag-to-mode mapping table (6 modes), graceful degradation chain, protocol for each of the 5 interactive modes, output format including Strategy field, and recursive feedback loop description.
- **Depends on**: None (domain tags already exist in plan.md)
- **Verify**: Read `agent/agents/build.md` and confirm the Functional Review Mode section exists between Full-Spectrum Review Mode and "What You Do NOT Do", contains all 6 evaluator modes, and includes the adversarial stance language.
- **Verified**: ✅ Insertion point confirmed (after line 363, before line 364 "## What You Do NOT Do"). All 6 modes present in mapping table. Adversarial stance language included. Graceful degradation chains complete. Recursive feedback loop has proper termination (max 3 iterations OR all Critical/High resolved). Edge case added: app startup failure in Visual QA falls back to code review.
- [x] done

### Step 4: Add Sprint Contract Negotiation mode to build.md [backend]
- **Action**: modify
- **File**: `agent/agents/build.md`
- **Details**: Add a new `## Contract Negotiation Mode` section after the new `## Functional Review Mode` section (before `## What You Do NOT Do`). This section defines a third operating mode for @build (alongside build mode and review mode):
  
  ```markdown
  ## Contract Negotiation Mode
  
  When dispatched in **contract mode** (your dispatch prompt will say "CONTRACT MODE"), you do not build anything. Instead, you negotiate a sprint contract — specific, testable done criteria for each step you're about to build.
  
  ### Contract Protocol
  
  1. **Read the plan file** and identify the next N steps you'll be building (N = your context budget).
  2. **For each step**, read the target file(s) and the step's Details.
  3. **Write testable done criteria** for each step. Good done criteria are:
     - **Specific**: "The `/api/users` endpoint returns 200 with `{id, name, email}` fields" not "API works"
     - **Testable**: Can be verified with a command, curl call, visual check, or file read
     - **Scoped**: Only covers what THIS step changes, not the whole feature
     - **Measurable**: "Test suite passes with ≥80% coverage on new code" not "tests are good"
  4. **Write the contract** to the plan file's `## Sprint Contract` section:
     
     | Step | Done Criteria | Verified |
     |------|--------------|----------|
     | 1 | {criterion 1}; {criterion 2} | [ ] |
     | 2 | {criterion 1} | [ ] |
  
  5. **Update each step's Done Criteria field** in the Implementation Steps section with the negotiated criteria.
  6. **Output the contract** for Randal to review.
  
  ### Contract Output Format
  
  ```
  CONTRACT: {n} steps | Sprint: Steps {start}-{end}
  
  ╔══════════════════════════════════════════════════════════════╗
  ║  📋 SPRINT CONTRACT                           @build · {model}║
  ╠══════════════════════════════════════════════════════════════╣
  ║                                                              ║
  ║  Sprint Scope: Steps {start} through {end}                   ║
  ║  Estimated Effort: {n} steps · ~{time}                       ║
  ║                                                              ║
  ║  Step {n}: {description}                                     ║
  ║    ☐ {done criterion 1}                                      ║
  ║    ☐ {done criterion 2}                                      ║
  ║                                                              ║
  ║  Step {n+1}: {description}                                   ║
  ║    ☐ {done criterion 1}                                      ║
  ║                                                              ║
  ║  Risks/Flags:                                                ║
  ║    {any concerns about feasibility, unclear requirements}    ║
  ╚══════════════════════════════════════════════════════════════╝
  ```
  
  ### What Makes Good Done Criteria
  
  ✅ "File `src/api/users.ts` exports a `getUser(id: string)` function that returns `User | null`"
  ✅ "`npm run test -- --grep 'rate limiter'` passes with ≥3 test cases covering allow/deny/reset"
  ✅ "Running `curl localhost:3000/api/health` returns `{"status": "ok"}` with HTTP 200"
  ✅ "The plan.md template includes a `## Sprint Contract` section between Implementation Steps and Files to Modify"
  
  ❌ "Code works correctly" (not specific)
  ❌ "Tests pass" (which tests? what do they verify?)
  ❌ "UI looks good" (not measurable)
  ❌ "Feature is complete" (not scoped to a single step)
  ```
- **Done Criteria**: build.md contains a `## Contract Negotiation Mode` section with: contract protocol (6 steps), output format, and examples of good/bad done criteria.
- **Depends on**: Step 2 (plan.md template has Sprint Contract section and Done Criteria field)
- **Verify**: Read `agent/agents/build.md` and confirm Contract Negotiation Mode section exists with protocol, output format, and examples.
- **Verified**: ✅ Insertion point correct (after Functional Review Mode, before What You Do NOT Do). Dependencies correctly declared (Step 2 for plan.md template). Contract protocol has 6 steps. Output format and good/bad examples present. Risks/Flags section handles unclear requirements during negotiation.
- [x] done

### Step 5: Add Pivot-or-Refine protocol to build.md [backend]
- **Action**: modify
- **File**: `agent/agents/build.md`
- **Details**: Two changes to build.md to extend the binary `NEEDS_REDESIGN` to a strategy spectrum:
  
  **Change A** — Extend the checkpoint output format (lines 228-261). Add a `Strategy` field to the checkpoint box. Insert **between** the `🔄 Checkpointing` line (line 258) and the `Next:` line (line 259), so the strategy assessment appears before the "what's next" action:
  ```markdown
  ║                                                              ║
  ║  📐 Strategy: {Refine|Partially Rework|Pivot|N/A}           ║
  ║     {1-2 sentence rationale if not N/A}                      ║
  ```
  
  **Change B** — Update "Handling Problems" section (lines 89-97). Replace the single `NEEDS_REDESIGN` paragraph (line 96) with a strategy spectrum:
  
  Replace:
  ```
  - **Fundamental approach is wrong** (the plan's design won't work): DO NOT try to redesign. Add a detailed note in `## Build Notes` explaining why, mark the step `- [!] NEEDS_REDESIGN`, and checkpoint immediately. The caller (Randal) will handle it.
  ```
  
  With:
  ```
  - **Approach needs adjustment** — Assess severity and report a strategy in your checkpoint:
    - **Refine**: Scores trending well, specific issues to fix. Continue building, fix issues in subsequent steps.
    - **Partially Rework**: Approach is mostly right but one component needs significant changes. Mark affected step(s) `- [!] REWORK` with a note explaining what needs to change. Continue with other steps if possible.
    - **Pivot**: Fundamental approach won't work. Mark step `- [!] PIVOT` with detailed explanation of why the approach fails and what alternatives exist. Checkpoint immediately. The caller (Randal) will handle redesign.
    
    The old `[!] NEEDS_REDESIGN` marker is equivalent to `[!] PIVOT`. Use the more specific markers above to give Randal better signal on what to do.
  ```
- **Done Criteria**: build.md checkpoint format includes a `Strategy` field. The "Handling Problems" section defines the Refine/Partially Rework/Pivot spectrum with markers `[!] REWORK` and `[!] PIVOT`. The old `NEEDS_REDESIGN` is documented as equivalent to `PIVOT`.
- **Depends on**: Step 3 (Functional Review Mode already includes Strategy in its output format)
- **Verify**: Read `agent/agents/build.md` and confirm: (1) checkpoint format has Strategy field, (2) Handling Problems section has Refine/Rework/Pivot spectrum, (3) NEEDS_REDESIGN equivalence is documented.
- **Verified**: ✅ Change A insertion point clarified (between Checkpointing line 258 and Next line 259). Change B target confirmed (line 96 exact match for NEEDS_REDESIGN paragraph). Old NEEDS_REDESIGN ↔ PIVOT equivalence documented for backward compatibility. No conflicts with Step 3's evaluator Strategy field — complementary (build-time vs review-time strategy signals).
- [x] done

### Step 6: Add Sprint Contract dispatch to Build Pipeline in randal.md [backend]
- **Action**: modify
- **File**: `agent/agents/randal.md`
- **Details**: Insert a new step 2.5 between step 2 ("Check if a branch should be created", line 208) and step 3 ("Dispatch @build", line 213) in the Build Pipeline. This new step dispatches @build in CONTRACT MODE before the build begins:

  Insert between current steps 2 and 3 (renumber subsequent steps):
  ```markdown
  2.5. **Dispatch @build in CONTRACT MODE** to negotiate sprint contracts for the upcoming batch:
     ```
     Write sprint contracts for the next batch of steps in the plan at .opencode/plans/{filename}.
     Read the plan file, identify the next {N} unchecked steps (your context budget), and write testable done criteria for each.
     
     CONTRACT MODE — do NOT build anything. Write done criteria only.
     
     CONTEXT BUDGET: Contract for at most {N} steps.
     
     Available skills: steer (GUI) {yes/no} · drive (terminal) {yes/no} · memory {yes/no}
     ```
     Parse the `CONTRACT:` header from @build's response. If the contract looks reasonable (criteria are specific and testable), proceed to dispatch @build for implementation. If @build flags risks or unclear requirements, report them to the user before proceeding.
     
     **Skip conditions**: Sprint contracts are skipped when:
     - The user said "quick mode" or "skip contracts"
     - Only 1-2 steps remain (overhead not worth it)
     - Resuming a build where contracts were already written for this batch
  ```

  Also update loop-state.json schema (lines 354-393) to add sprint contract tracking. Insert after `"task_id"` field (line 374):
  ```json
  "sprint_contract": {
    "steps": [6, 7, 8],
    "negotiated_at": "2026-03-25T20:16:00Z",
    "skipped": false
  },
  "eval_iterations": 0,
  "eval_strategy": null,
  ```
- **Done Criteria**: randal.md Build Pipeline includes a step 2.5 that dispatches @build in CONTRACT MODE before the build dispatch. The dispatch prompt says "CONTRACT MODE" and passes the context budget. Skip conditions are documented. loop-state.json schema includes `sprint_contract`, `eval_iterations`, and `eval_strategy` fields.
- **Depends on**: Step 4 (build.md has Contract Negotiation Mode)
- **Verify**: Read `agent/agents/randal.md` and confirm: (1) Build Pipeline has a contract dispatch step between branch check and build dispatch, (2) loop-state schema has new fields.
- **Verified**: ✅ Insertion point confirmed (between step 2 at line 208 and step 3 at line 213). loop-state.json schema `task_id` field at line 374 confirmed. Sprint contract dispatch happens at correct point in pipeline — after branch check but before build dispatch. Skip conditions are well-defined. No conflicts with steps 1-5 (different files). Dependencies on Step 4 (build.md Contract Negotiation Mode) are correct.
- [x] done

### Step 7: Replace Full-Spectrum Review dispatch with Adaptive Evaluator dispatch in randal.md [backend]
- **Action**: modify
- **File**: `agent/agents/randal.md`
- **Details**: Replace the "For @build dispatch — Full-Spectrum Review (verification)" section (lines 530-541) and the combined Full-Spectrum Review Checklist that follows (lines 543-583) with an Adaptive Evaluation Protocol. The new section:

  Replace lines 530-583 with:
  ```markdown
  **For @build dispatch — Adaptive Evaluation (verification):**

  After each build turn completes, Randal dispatches an **evaluation pass** that goes beyond reading diffs — it interacts with build outputs based on domain context.

  ### Evaluator Dispatch Protocol

  1. **Read domain tags** from the steps just completed. Collect all `[tag]` markers from those steps in the plan file.
  2. **Select evaluator mode** based on the dominant tag(s):
     
     | Domain Tags | Evaluator Mode |
     |-------------|---------------|
     | `[frontend]`, `[ui]`, `[design]` | Visual QA |
     | `[backend]`, `[api]`, `[database]` | Functional QA |
     | `[docs]`, `[content]`, `[marketing]` | Content Review |
     | `[config]`, `[ci]`, `[devops]`, `[infrastructure]` | Operational QA |
     | `[testing]` | Test Quality Review |
     | Mixed or no tags | Code Review Only (Full-Spectrum, current behavior) |
     
     If the batch spans domains, use the mode for the majority of steps. If tied, use the mode for the LAST step (most recent work).

  3. **Determine available tools** for the selected mode:
     - Visual QA: Check steer availability, check Playwright MCP availability
     - Functional QA: curl/fetch always available, check if test suite exists
     - Content Review: File reading always available
     - Operational QA: Check if validation commands exist in package.json/Makefile
     - Test Quality Review: Check if test runner is configured

  4. **Dispatch @build in FUNCTIONAL REVIEW MODE**:
     ```
     Review the code just built for the plan at .opencode/plans/{filename}.
     
     FUNCTIONAL REVIEW MODE
     Evaluator Mode: {selected_mode}
     Domain Tags: {tags from completed steps}
     Steps to Evaluate: {step_range}
     Sprint Contract Criteria: {done criteria from contract, if available}
     
     Available tools for evaluation:
     - steer (GUI): {yes/no}
     - Playwright MCP: {yes/no}
     - drive (terminal): {yes/no}
     - Test suite: {yes/no, runner command}
     
     Git diff: {before_hash}..HEAD
     
     Be adversarial. Find what breaks, not what works.
     ```

  5. **Parse the evaluation response**: Look for `FUNCTIONAL_REVIEW:` header. Extract mode, findings by severity, strategy recommendation.
  6. **If Code Review Only mode** (mixed/no tags): Fall back to the Full-Spectrum lens-based review. Construct the review prompt with ALL lens checklists as before. This is the graceful degradation for steps without clear domain tags.
  7. **Handle findings by severity**:
     - Critical or High: Add fix-steps to the plan, continue build loop, re-evaluate after fixes.
     - Medium or Low: Log in Build Notes, report to user. User decides.
  8. **Update loop-state**: Increment `eval_iterations`, save `eval_strategy` from the response.
  9. **Max evaluation iterations**: Default 3. If after 3 rounds of fix → re-evaluate, Critical/High findings persist, pause the build and escalate to user: "Evaluation loop hit max iterations. {n} unresolved findings remain. Options: continue anyway, rework, or abort."
  10. This evaluation pass happens every build checkpoint (default). Disable with "skip reviews" or "no review pass."

  **Full-Spectrum Review Checklist (for Code Review Only fallback):**
  ```
  
  Then keep the existing lens checklists (Architect, Crafter, Strategist, Auditor, Narrator, Diplomat, Provocateur, Catalyst) unchanged below this — they remain as the Code Review Only fallback content.
- **Done Criteria**: randal.md has an "Adaptive Evaluation" section that replaces the old "Full-Spectrum Review" dispatch. It includes: domain tag reading, mode selection table, tool availability checking, FUNCTIONAL REVIEW MODE dispatch prompt with adversarial instruction, finding severity handling, max iteration cap (3), and graceful degradation to Code Review Only with the existing lens checklists preserved as fallback.
- **Depends on**: Step 3 (build.md has Functional Review Mode)
- **Verify**: Read `agent/agents/randal.md` and confirm: (1) "Adaptive Evaluation" section exists, (2) dispatch prompt says "FUNCTIONAL REVIEW MODE" with mode and domain tags, (3) lens checklists preserved as fallback, (4) max iteration cap documented.
- **Verified**: ✅ Replacement target confirmed (lines 530-583: dispatch logic 530-541 + lens checklists 543-583). The plan correctly preserves lens checklists as "Code Review Only fallback" content. No orphaned references — the "Primary Lens (implementation)" section (lines 519-528) is unaffected (it governs build dispatch, not review dispatch). The replacement introduces a 10-step protocol with proper dispatch prompt. Edge case note: The tie-breaking rule (use mode for LAST step when domains tied) differs from the lens tie-breaker (FIRST step) — this is intentional since review looks at what was just built (recency matters) while implementation lens looks at what's about to be built (setting the tone). Max iteration cap (3) and escalation on exhaustion correctly documented. No conflicts with Step 6 (different section of randal.md).
- [ ] pending

### Step 8: Add Pivot-or-Refine handling to Build Pipeline in randal.md [backend]
- **Action**: modify
- **File**: `agent/agents/randal.md`
- **Details**: Add strategy handling to the Build Pipeline and Error Handling sections. After @build returns from evaluation (new step from Step 7), Randal parses the `Strategy:` field and acts on it.

  **Change A** — Insert after the evaluator dispatch logic (from Step 7's section), as a new subsection:
  ```markdown
  ### Pivot-or-Refine Handling

  After each evaluation pass, parse the `Strategy:` field from the `FUNCTIONAL_REVIEW:` or `PROGRESS:` output:

  - **Strategy: Refine** — Scores trending well. Add fix-steps for Critical/High findings. Continue the build loop normally. No user intervention needed.
  
  - **Strategy: Partially Rework** — Approach mostly right but one component needs significant changes.
    1. Report to user:
       ```
       ⚠️ Evaluator recommends partial rework: {rationale}
          Affected: Step {n} — {description}
          
          Options:
          - "continue" — proceed with fixes, see if rework resolves naturally
          - "rework" — re-plan the affected steps, then rebuild
          - "abort" — stop the build
       ```
    2. Wait for user input. If "rework": invoke @plan to re-draft affected steps, then continue build.
    3. Update loop-state: `eval_strategy: "partially_rework"`.

  - **Strategy: Pivot** — Fundamental approach isn't working.
    1. Pause the build immediately. Set `status: "paused"` in loop-state.
    2. Report to user:
       ```
       🔄 Evaluator recommends pivot: {rationale}
          The current approach at Step {n} has fundamental issues.
          
          Branch opencode/{slug} preserved with partial work.
          
          Options:
          - "re-plan" — go back to planning with the evaluator's feedback
          - "override" — ignore the recommendation and continue building
          - "abort" — stop the build entirely
       ```
    3. If "re-plan": Dispatch @plan with the evaluator's rationale as context. Create new plan steps. Resume build.
    4. Update loop-state: `eval_strategy: "pivot"`.

  - **Strategy: N/A or missing** — No strategic concern. Continue normally.
  ```

  **Change B** — Update the existing Error Handling section (lines 303-331). After the existing `NEEDS_REDESIGN`-equivalent error handling, add a cross-reference:
  ```markdown
  - If @build's checkpoint includes `[!] PIVOT` or `[!] REWORK` markers: See **Pivot-or-Refine Handling** above for the full protocol. These markers replace the legacy `[!] NEEDS_REDESIGN`.
  ```
- **Done Criteria**: randal.md contains a "Pivot-or-Refine Handling" subsection that defines actions for Refine (continue), Partially Rework (ask user), and Pivot (pause + escalate). Error Handling section cross-references the new protocol. loop-state `eval_strategy` is updated on each path.
- **Depends on**: Step 5 (build.md has pivot-or-refine protocol), Step 7 (randal.md has evaluator dispatch that returns Strategy)
- **Verify**: Read `agent/agents/randal.md` and confirm: (1) Pivot-or-Refine Handling subsection exists with all 3 strategies, (2) user-facing messages for Partially Rework and Pivot are documented, (3) Error Handling section references [!] PIVOT and [!] REWORK.
- **Verified**: ✅ Change A: Insertion after Step 7's evaluator section is correct — new subsection follows the evaluation protocol. Change B: Error Handling section (lines 303-331) ends before `### Git Worktree Strategy` (line 333). Cross-reference bullet should be added after line 331 (end of the "build stalled" block). All three strategies (Refine/Partially Rework/Pivot) have distinct user-facing messages and loop-state updates. Dependencies correct: requires Step 5 (build.md pivot markers) and Step 7 (evaluator dispatch that returns Strategy). The "Strategy: N/A or missing" fallback handles backward compatibility. Edge case note: The existing `NEEDS_REDESIGN` handling is in build.md only (not randal.md Error Handling), so the cross-reference here is additive, not replacing anything.
- [ ] pending

### Step 9: Add model-adaptive context dispatch and Playwright MCP discovery to randal.md [config]
- **Action**: modify
- **File**: `agent/agents/randal.md`
- **Details**: Two changes to randal.md:

  **Change A** — Update Capability Discovery (lines 481-487). Add Playwright MCP probing alongside steer/drive/memory:
  ```markdown
  ## Capability Discovery

  When dispatching subagents, probe for available capabilities and include in the prompt:
  `Available skills: steer (GUI) {yes/no} · drive (terminal) {yes/no} · memory {yes/no} · playwright {yes/no}`
  
  Probing method:
  - **steer**: Check if steer skill is available (already implemented)
  - **drive**: Check if drive skill is available (already implemented)
  - **memory**: Check if memory tools respond (already implemented)
  - **playwright**: Read the project's opencode config (`.opencode/config.json` or `opencode.json`). Check if an MCP server entry contains "playwright" in its name or command. If found, playwright is available for Visual QA and Functional QA evaluator modes.
  
  This tells @plan whether to include visual verification steps (if steer or playwright available)
  and tells @build what tools it can use for evaluation.
  ```

  **Change B** — Update the Build Pipeline dispatch logic. After calling `model_context` (step 1, line 204), add context strategy handling:
  ```markdown
  1.1. **Read context strategy**: From the `model_context` response, extract `context_strategy` and `session_length`.
     - If `context_strategy` is `"compact"` and a `task_id` exists in loop-state: Prefer warm resume via `task_id`. The model can handle compacted context from prior turns.
     - If `context_strategy` is `"reset"`: Always dispatch fresh sessions. Do NOT pass `task_id` for warm resume. Each @build invocation starts clean with full context budget.
     - If `session_length` is `"short"`: Reduce `build_steps_per_invocation` by 1 (minimum 2) to avoid context exhaustion mid-step.
     - If `session_length` is `"long"`: Allow the default or user-specified budget. No adjustment needed.
  ```

  Also update the Task ID handling paragraph (line 246) to be conditional on context_strategy:
  ```markdown
  **Task ID handling**: Extract the `task_id` from the Task tool's response after each @build dispatch. Save it in the build's loop-state entry under `task_id`. When re-invoking @build:
  - If `context_strategy` is `"compact"` AND a `task_id` exists in loop-state AND the session hasn't expired: pass `task_id` for warm resume (continues the same subagent session with previous context).
  - If `context_strategy` is `"reset"` OR no `task_id` exists OR the session expired: start a fresh session. Do not pass `task_id`.
  ```
- **Done Criteria**: randal.md Capability Discovery section probes for playwright MCP via opencode config. Build Pipeline reads `context_strategy` and `session_length` from model_context and adjusts dispatch behavior accordingly. Task ID handling is conditional on context_strategy. `session_length: "short"` reduces budget by 1.
- **Depends on**: Step 1 (model-context.ts returns context_strategy and session_length)
- **Verify**: Read `agent/agents/randal.md` and confirm: (1) Capability Discovery mentions playwright with probing method, (2) Build Pipeline step 1.1 reads context_strategy, (3) Task ID handling is conditional on context_strategy, (4) session_length "short" reduces budget.
- **Verified**: ✅ Change A: Capability Discovery (lines 481-487) replacement confirmed. Playwright MCP probing via opencode config is consistent with existing steer/drive probing (both check for availability of external tools). Edge case note: Should specify that if opencode config file doesn't exist, playwright = no (add fallback). Change B: Step 1 at line 204, step 1.1 inserts after it — correct. Task ID handling at line 246 — replacement text makes warm resume conditional on context_strategy "compact". Dependency on Step 1 (model-context.ts returns context_strategy/session_length) is correct. No conflicts with Steps 6-8 (different sections of randal.md). The `session_length: "short"` budget reduction (by 1, minimum 2) is conservative and safe.
- [ ] pending

### Step 10: Delete Claude Code and Codex adapters and update index.ts [backend]
- **Action**: delete + modify
- **Files**:
  - `packages/runner/src/agents/claude-code.ts` — DELETE
  - `packages/runner/src/agents/claude-code.test.ts` — DELETE
  - `packages/runner/src/agents/codex.ts` — DELETE
  - `packages/runner/src/agents/codex.test.ts` — DELETE
  - `packages/runner/src/agents/index.ts` — MODIFY
- **Details**: 
  Delete the four adapter files. Then modify `index.ts` to remove all references:

  **index.ts changes** — Remove lines 2-3 (claude-code and codex imports), remove lines 11-12 (dict entries), remove lines 38-39 (named exports). Result:
  ```typescript
  import type { AgentAdapter } from "./adapter.js";
  import { mock } from "./mock.js";
  import { opencode } from "./opencode.js";

  export type { AgentAdapter, RunOpts } from "./adapter.js";

  const adapters: Record<string, AgentAdapter> = {
  	opencode,
  	mock,
  };

  /**
   * Get an agent adapter by name.
   * Throws if the adapter is not found.
   */
  export function getAdapter(name: string): AgentAdapter {
  	const adapter = adapters[name];
  	if (!adapter) {
  		throw new Error(
  			`Unknown agent adapter: "${name}". Available: ${Object.keys(adapters).join(", ")}`,
  		);
  	}
  	return adapter;
  }

  /**
   * Register a custom agent adapter.
   */
  export function registerAdapter(name: string, adapter: AgentAdapter): void {
  	adapters[name] = adapter;
  }

  export { opencode } from "./opencode.js";
  export { mock } from "./mock.js";
  ```
- **Done Criteria**: The four adapter files are deleted. `index.ts` only imports and exports `opencode` and `mock`. `getAdapter("claude-code")` and `getAdapter("codex")` would throw "Unknown agent adapter". `tsc --noEmit` passes (no broken imports).
- **Depends on**: None (independent of brain changes)
- **Verify**: Confirm files deleted (`ls packages/runner/src/agents/` shows only `adapter.ts`, `index.ts`, `mock.ts`, `opencode.test.ts`, `opencode.ts`). Run `npx tsc --noEmit` or equivalent type check to confirm no broken imports.
- **Verified**: ✅ index.ts line numbers confirmed accurate: imports (lines 2-3), dict entries (lines 11-12), exports (lines 38-39). All four files to delete confirmed to exist. ⚠️ **ADDITIONAL REFERENCES FOUND**: `packages/runner/src/mcp-server.test.ts` line 24 uses `agent: "claude-code"` in a test fixture. `packages/runner/src/plan-parser.test.ts` lines 179, 185 use `"claude-code"` as test data. These are string literals in tests (not import references) so they won't break the build, but should be updated to `"opencode"` for consistency. @build should update these two test files as part of this step.
- [ ] pending

### Step 11: Update README.md to position OpenCode as sole agent [docs]
- **Action**: modify
- **File**: `README.md`
- **Details**: Five specific changes to remove Claude Code and Codex references:

  **Change A** — Line 18. Replace:
  ```
  Randal wraps agent CLIs — [OpenCode](https://github.com/nickthecook/opencode), [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex) — in a persistent execution loop and gives them superpowers:
  ```
  With:
  ```
  Randal wraps [OpenCode](https://github.com/nickthecook/opencode) in a persistent execution loop and gives it superpowers:
  ```

  **Change B** — Line 64. Replace:
  ```
  randal run spec.md --agent claude-code --model claude-sonnet-4
  ```
  With:
  ```
  randal run spec.md --model claude-sonnet-4
  ```

  **Change C** — Line 272. Replace:
  ```
  The official Docker image includes Bun, Meilisearch, Claude Code, and Randal.
  ```
  With:
  ```
  The official Docker image includes Bun, Meilisearch, OpenCode, and Randal.
  ```

  **Change D** — Line 328. Replace:
  ```
  The image includes Bun, Meilisearch, Claude Code, and Randal — ready to run.
  ```
  With:
  ```
  The image includes Bun, Meilisearch, OpenCode, and Randal — ready to run.
  ```

  **Change E** — Line 408. Replace the prerequisites table row:
  ```
  | **Agent CLI** (at least one) | [OpenCode](https://github.com/nickthecook/opencode) · [Claude Code](https://docs.anthropic.com/en/docs/claude-code) · [Codex](https://github.com/openai/codex) |
  ```
  With:
  ```
  | **Agent CLI** | [OpenCode](https://github.com/nickthecook/opencode) |
  ```
- **Done Criteria**: README.md contains zero references to "Claude Code" or "Codex". OpenCode is positioned as the sole agent CLI. The "wraps agent CLIs" line says "wraps OpenCode". Prerequisites table lists only OpenCode. Docker descriptions reference OpenCode instead of Claude Code.
- **Depends on**: Step 10 (adapters deleted first)
- **Verify**: `grep -i "claude.code\|codex" README.md` returns no results. Also verify no references remain in `docs/` directory.
- **Verified**: ✅ All 5 README.md changes have correct line numbers (18, 64, 272, 328, 408) — each verified against actual file content. ⚠️ **ADDITIONAL REFERENCES FOUND in docs/**: `docs/deployment-guide.md` lines 12, 195 reference claude-code/codex. `docs/config-reference.md` lines 158, 601, 660 reference claude-code. `docs/architecture.md` lines 110-111 have adapter table entries for claude-code and codex. `docs/cli-reference.md` lines 82, 120, 395 reference claude-code. Requirement 6 says "Remove references to Claude Code and Codex throughout docs" — these 4 docs files need updating too. @build should handle these as part of this step or add a follow-up step. `.Claude/prds/` reference is a historical PRD and can be left as-is.
- [ ] pending

## Sprint Contract

{Written by @build before building a batch. Contains testable done criteria negotiated for each step in the upcoming sprint. Left empty during planning — populated during build pipeline.}

## Files to Modify

| File | Action | Step | Summary |
|------|--------|------|---------|
| `agent/tools/model-context.ts` | modify | 1 | Add `context_strategy` and `session_length` fields to calculate() and fallback() |
| `agent/agents/plan.md` | modify | 2 | Add Done Criteria field to step template; add Sprint Contract section to plan template |
| `agent/agents/build.md` | modify | 3, 4, 5 | Add Functional Review Mode (adaptive evaluator), Contract Negotiation Mode, and Pivot-or-Refine protocol |
| `agent/agents/randal.md` | modify | 6, 7, 8, 9 | Add sprint contract dispatch, adaptive evaluator dispatch, pivot-or-refine handling, context-adaptive dispatch, Playwright MCP discovery |
| `packages/runner/src/agents/claude-code.ts` | delete | 10 | Remove Claude Code adapter |
| `packages/runner/src/agents/claude-code.test.ts` | delete | 10 | Remove Claude Code adapter test |
| `packages/runner/src/agents/codex.ts` | delete | 10 | Remove Codex adapter |
| `packages/runner/src/agents/codex.test.ts` | delete | 10 | Remove Codex adapter test |
| `packages/runner/src/agents/index.ts` | modify | 10 | Remove claude-code/codex imports, registry entries, and exports |
| `packages/runner/src/mcp-server.test.ts` | modify | 10 | Update `"claude-code"` test fixture to `"opencode"` |
| `packages/runner/src/plan-parser.test.ts` | modify | 10 | Update `"claude-code"` test data to `"opencode"` |
| `README.md` | modify | 11 | Remove Claude Code/Codex references, position OpenCode as sole agent |
| `docs/deployment-guide.md` | modify | 11 | Remove Claude Code/Codex references |
| `docs/config-reference.md` | modify | 11 | Remove Claude Code/Codex references from agent options |
| `docs/architecture.md` | modify | 11 | Remove claude-code and codex from adapter table |
| `docs/cli-reference.md` | modify | 11 | Remove claude-code from command examples |

## Dependencies / Prerequisites

- Existing agent files (randal.md, plan.md, build.md) as base
- model-context.ts as base
- packages/runner/src/agents/ for cleanup

## Risks / Considerations

- Sprint contracts add latency to the build pipeline (one extra dispatch before building)
- Recursive evaluator loop could get expensive if not bounded (need max iteration cap of 3)
- Playwright MCP adds a dependency — needs to be clearly optional with probing
- Removing Claude Code/Codex is irreversible — but user confirmed this is intentional (sole user)

## Rollback Plan

- git revert the branch

## Acceptance Criteria

### Core Protocol (Steps 1-5)
- [ ] `model-context.ts` calculate() returns `context_strategy` and `session_length` fields with correct tier mapping: Tier 1→compact/long, Tier 2→reset/medium, Tier 3→reset/short
- [ ] `model-context.ts` fallback() returns `context_strategy: "reset"` and `session_length: "medium"`
- [ ] `plan.md` template step structure includes `Done Criteria` field between Verify and checkbox
- [ ] `plan.md` template includes `## Sprint Contract` section between Implementation Steps and Files to Modify
- [ ] `build.md` contains `## Functional Review Mode` section with all 6 evaluator modes in domain-tag mapping table
- [ ] `build.md` Functional Review Mode includes adversarial evaluator stance (explicit "find what breaks" language)
- [ ] `build.md` Functional Review Mode includes graceful degradation chain for each interactive mode, ending in code review fallback
- [ ] `build.md` recursive feedback loop specifies max 3 iterations with explicit termination conditions
- [ ] `build.md` contains `## Contract Negotiation Mode` with 6-step protocol, output format, and good/bad criteria examples
- [ ] `build.md` checkpoint format includes `Strategy: {Refine|Partially Rework|Pivot|N/A}` field
- [ ] `build.md` Handling Problems section defines Refine/Rework/Pivot spectrum with `[!] REWORK` and `[!] PIVOT` markers
- [ ] `build.md` documents `[!] NEEDS_REDESIGN` as equivalent to `[!] PIVOT` for backward compatibility

### Orchestration (Steps 6-9)
- [ ] `randal.md` Build Pipeline includes Contract Negotiation dispatch (step 2.5) before build dispatch
- [ ] `randal.md` sprint contract dispatch has skip conditions (quick mode, ≤2 steps, already negotiated)
- [ ] `randal.md` Full-Spectrum Review dispatch replaced with Adaptive Evaluation Protocol
- [ ] `randal.md` evaluator dispatch passes domain tags, evaluator mode, and available tools to @build
- [ ] `randal.md` evaluator dispatch says "FUNCTIONAL REVIEW MODE" and "Be adversarial"
- [ ] `randal.md` Code Review Only fallback preserves all 8 lens checklists (Architect through Catalyst)
- [ ] `randal.md` Pivot-or-Refine Handling defines user-facing messages for Partially Rework and Pivot
- [ ] `randal.md` max evaluation iterations = 3 with escalation to user on exhaustion
- [ ] `randal.md` Capability Discovery probes for Playwright MCP via opencode config
- [ ] `randal.md` reads `context_strategy` from model_context and uses it for warm resume vs fresh session
- [ ] `randal.md` `session_length: "short"` reduces build_steps_per_invocation by 1
- [ ] `loop-state.json` schema includes `sprint_contract`, `eval_iterations`, `eval_strategy` fields

### Cleanup (Steps 10-11)
- [ ] `packages/runner/src/agents/claude-code.ts` deleted
- [ ] `packages/runner/src/agents/claude-code.test.ts` deleted
- [ ] `packages/runner/src/agents/codex.ts` deleted
- [ ] `packages/runner/src/agents/codex.test.ts` deleted
- [ ] `packages/runner/src/agents/index.ts` only imports/exports opencode and mock
- [ ] `tsc --noEmit` passes (no broken imports from deleted adapters)
- [ ] `README.md` contains zero references to "Claude Code" or "Codex"
- [ ] `README.md` positions OpenCode as sole agent CLI in intro, prerequisites, and Docker sections

## Build Notes

{Reserved for @build — deviations, issues, observations during execution}

## Planning Progress

- [x] Requirements gathered (Turn 0 — from conversation)
- [x] Discovery (Turn 1 — 6 files read: build.md, randal.md, plan.md, model-context.ts, index.ts, agents/ dir. Architecture overview written. ~14 steps estimated.)
- [x] Drafting (Turn 2-3 — All 11 steps drafted. Steps 1-5: model-context.ts, plan.md template, build.md evaluator/contract/pivot. Steps 6-9: randal.md sprint contract dispatch, adaptive evaluator dispatch, pivot-or-refine handling, context-adaptive dispatch + Playwright MCP. Steps 10-11: adapter cleanup + README update. Consolidated from original 14 to 11 by merging related changes.)
- [x] Verification Pass 1 (Turn 4 — Steps 1-5 verified. model-context.ts line numbers confirmed accurate, backward compatible. plan.md template insertion points correct. build.md evaluator protocol: all 6 modes present, graceful degradation complete, recursive loop has termination conditions, edge case added for app startup failure. Contract Negotiation Mode: dependencies correct, content complete. Pivot-or-Refine: Strategy insertion point clarified, NEEDS_REDESIGN backward compat documented.)
- [x] Verification Pass 2 (Turn 5 — Steps 6-11 verified. All randal.md insertion points confirmed against actual line numbers. Step 6: sprint contract dispatch between steps 2-3 correct, loop-state schema update point confirmed. Step 7: Full-Spectrum Review replacement range 530-583 confirmed, lens checklists preserved as fallback, tie-breaking rule intentionally differs from implementation lens (LAST vs FIRST). Step 8: Pivot-or-Refine after evaluator section correct, Error Handling cross-reference insertion at line 331 confirmed. Step 9: Capability Discovery and Task ID handling line numbers confirmed, playwright probing pattern consistent. Step 10: ⚠️ Found 2 additional test files with claude-code string refs (mcp-server.test.ts, plan-parser.test.ts) — added to step. Step 11: ⚠️ Found 4 additional docs files with claude-code/codex refs (deployment-guide.md, config-reference.md, architecture.md, cli-reference.md) — added to step.)
