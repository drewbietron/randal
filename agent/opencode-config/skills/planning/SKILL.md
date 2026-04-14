---
name: planning
description: Planning loop phases 1-3 — discovery, drafting, verification. Dispatch templates, checkpoint parsing, quick-mode rules.
---

# Planning Pipeline — Phase 1-3: Planning Loop (You -> @plan, Autonomous)

1. **Get the context budget**: Call `model_context` with the current model's provider and model IDs. Extract `budget.plan_files_per_discovery_turn` and `budget.plan_steps_per_drafting_turn`.

2. **Dispatch @plan** with a prompt like:
   ```
   Work on the plan at .opencode/plans/{filename}.
   Read the plan file to determine your current phase and progress.
   
   CONTEXT BUDGET: Discover at most {N} files this turn.
   OR: Draft at most {M} steps this turn.
   OR: Verify at most {M} steps this turn.
   
    Available tools: bash ✅ · gh (GitHub CLI) {✅/❌} · steer (GUI) {yes/no} · drive (terminal) {yes/no} · memory {yes/no}
   
   When you reach your budget or complete your current phase, 
   checkpoint and return your progress.
   ```

3. **Parse @plan's checkpoint**: Look for the `PLAN_PROGRESS:` header line. Extract phase, turn number, steps drafted.

   If the `PLAN_PROGRESS:` header is not found, fall back to reading the plan file's Status field and Planning Progress section to determine the current phase and progress. Log a warning but continue the loop.

4. **Report to user**:
   ```
   📋 Plan update: {slug} (Phase: {phase}, Turn {n}/~{est})
      Last action: {what @plan did this turn}
      Next: {what comes next}
      Est. remaining: ~{n} turns, ~{time}
      
      Re-invoking @plan for next turn...
   ```

   Also emit the machine-readable tag:
   `<progress>Planning: Phase {phase}, Turn {n}. {details}</progress>`

5. **Update loop-state.json**: Call `loop_state_write` to persist progress.

6. **Re-invoke @plan** with fresh context and updated budget.

7. **Repeat** until @plan reports `Status: Ready`.

8. **Present the plan to the user**:
   ```
   📋 Plan complete: {slug}
      {total_steps} steps across {total_files} files
      Estimated build time: ~{time} ({n} @build turns)
      
      Review the plan at: .opencode/plans/{filename}
      
      Say "build it" to start, or suggest changes.
   ```

9. **Wait for user approval** before transitioning to Build.

## Quick Mode

In **quick mode**: Tell @plan to do discovery + drafting in one pass (skip separate discovery phase, skip verification). Single turn if possible, max 2 turns.
