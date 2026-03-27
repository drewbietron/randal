---
name: building
description: Build pipeline steps 1-11, dispatch templates, checkpoint parsing, parallel step execution, error handling, stall detection.
---

# Build Pipeline

1. **Get the context budget**: Call `model_context`. Extract `budget.build_steps_per_invocation`.

1.5. **Pre-flight check**: Run `git rev-parse --is-inside-work-tree` to verify the workspace is a git repo. If it fails, ask the user: "This directory isn't a git repo. Should I initialize one (`git init`), or skip git operations for this build?" If skipping git, instruct @build to skip branch creation and commits.

2. **Check if a branch should be created**:
   - Read the plan file to get the plan slug.
   - If no branch exists for this plan: tell @build to create `{branch-prefix}/{plan-slug}`.
   - If user requested worktree isolation: create worktree first via `git worktree add`.

3. **Dispatch @build** with:
   ```
   Execute the implementation plan at .opencode/plans/{filename}.
   Read the plan file, find the first unchecked step, and begin.
   
   CONTEXT BUDGET: Complete at most {N} steps, then checkpoint.
   
   Git branch: {branch-prefix}/{plan-slug}
   Commit after each completed step using the format in your instructions.
   
   Available skills: steer (GUI) {yes/no} · drive (terminal) {yes/no} · memory {yes/no}
   ```
   If resuming, include: `task_id: {saved_task_id}` for warm resume.

4. **Parse @build's checkpoint**: Look for the `PROGRESS:` header line. Extract completed/total, blocked count, current step.

   If the `PROGRESS:` header is not found in the subagent's response, fall back to reading the plan file directly. Count `- [x]` lines for completed steps and `- [ ]` lines for remaining. Log a warning in your report: "⚠️ Checkpoint header missing — inferred progress from plan file." This ensures the loop continues even if the subagent's output format is slightly off.

5. **Report to user**:
   ```
   🏗️ Build update: {slug} ({completed}/{total} steps, {pct}%)
      Last completed: Step {n} — {description} ✅
      Next up: Step {n} — {description}
      Est. remaining: ~{time}
      
      Re-invoking @build for next batch...
   ```

   Also emit the machine-readable tag:
   `<progress>Building: {completed}/{total} steps. Step {next} next. Est ~{time}.</progress>`

6. **Update loop-state.json** with progress, save task_id for resume.

   **Task ID handling**: Extract the `task_id` from the Task tool's response after each @build dispatch. Save it in the build's loop-state entry under `task_id`. When re-invoking @build, if a `task_id` exists in loop-state, pass it to the Task tool for warm resume (continues the same subagent session with previous context). If no `task_id` exists or the session has expired, start a fresh session.

7. **Re-invoke @build** with fresh context.

8. **Repeat** until PROGRESS shows all steps complete.

9. **Report completion**:
   ```
   ✅ Build complete: {slug}
      {total} steps completed · {total_time} · {total_tokens} tokens
       Branch: {branch-prefix}/{plan-slug} (ready for review/merge)
       PR: {pr_url} (if created)
       
       💾 Commits:
          {hash} {message}
          {hash} {message}
          ...
       
       All acceptance criteria verified. ✅
   ```

   Also emit: `<promise>COMPLETE</promise>`

10. **Update loop-state.json**: Set status to "complete".

11. **Store session summary in memory** (if available):
    `memory_store("Completed: {summary}. {N} steps. Branch: {branch-name}.", "session-complete")`

## Parallel Step Execution

When the plan contains steps with no dependencies between them (their "Depends on" fields don't reference each other), you MAY dispatch multiple @build subagents in parallel for different steps.

**Rules for parallel dispatch:**
1. Each parallel @build gets its OWN step range and its own context budget.
2. Steps MUST be truly independent — no shared files, no ordering requirements.
3. Each parallel @build works on the same branch but different files.
4. Parse all PROGRESS headers when parallel builds return.
5. If any parallel build reports a conflict or error, pause all parallel work and switch to sequential.
6. Parallel dispatch is optional — use it when you see clear opportunities (e.g., "Step 3: add tests" and "Step 4: update docs" can run simultaneously).
7. Track each parallel dispatch as a separate iteration in loop-state.json.
8. Never parallelize steps that modify the same file.

**When NOT to parallelize:**
- Steps with explicit dependencies
- Steps that modify the same file
- When the plan has fewer than 4 remaining steps (overhead not worth it)
- When cost budget is tight (parallel = more total tokens = higher cost)

## Error Handling

- If @build returns an error or reports being blocked on all remaining steps:
  1. Update loop-state.json with `status: "error"` and error description.
  2. Report to user with the error details and options:
     ```
     ❌ Build error: {slug} ({completed}/{total} steps)
        Step {n} failed: {error description}
        
        Options:
        - "retry" — re-invoke @build to try again
        - "skip" — mark step as blocked, continue to next
        - "abort" — stop the build, keep progress
     ```
  3. Wait for user input.

- If @plan cannot complete a phase after 3 consecutive turns with no progress:
  1. Report the struggle to the user.
  2. Ask if they want to provide more context or simplify the scope.

- If @build completes 3 consecutive iterations with zero new steps completed (no forward progress), pause the build with `status: "error"` and report:
  ```
  ❌ Build stalled: {slug} — 3 iterations with no progress
     Completed: {n}/{total} steps
     Last attempted: Step {n} — {description}
     
     The remaining steps may be too complex or fundamentally blocked.
     Options: provide guidance, simplify the plan, or abort.
  ```
