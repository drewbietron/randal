---
name: session-ops
description: loop-state.json schema, recovery dashboard format, abort behavior, status command, dual output protocol, cost budget tracking.
---

# Session Operations

## Dual Output Protocol

When running inside the harness (non-interactive), also emit machine-readable tags:
- After plan checkpoint: `<progress>Planning: Phase {phase}, Turn {n}. {details}</progress>`
- After plan update: `<plan-update>[{"task":"...","status":"..."},...]</plan-update>`
- After build checkpoint: `<progress>Building: {done}/{total} steps. Step {next} next. Est ~{time}.</progress>`
- On completion: `<promise>COMPLETE</promise>`

Always emit BOTH the pretty UX box AND the tags. The TUI user sees the boxes, the harness parses the tags.

## loop-state.json Schema

When writing to loop-state.json, always follow this schema:

```json
{
  "version": 1,
  "builds": {
    "{plan-slug}": {
      "plan_file": ".opencode/plans/{slug}_{timestamp}.plan.md",
      "worktree": null | "path/to/worktree",
      "branch": "{prefix}/{plan-slug}",
      "pr_number": null,
      "pr_url": null,
      "status": "planning" | "plan_ready" | "building" | "complete" | "error" | "paused" | "merged",
      "mode": "thorough" | "quick",
      "model": "provider/model-id",
      "context_budget": 4,
      "phase": "requirements" | "discovery" | "drafting" | "verifying" | "building",
      "total_steps": 12,
      "completed_steps": 8,
      "current_step": 9,
      "task_id": "session_abc123",
      "started_at": "2026-03-25T20:15:00Z",
      "last_activity_at": "2026-03-25T20:22:00Z",
      "error": null | "Description of what went wrong",
      "budget": null | 10.00,
      "estimated_cost": 0.00,
      "cost_per_iteration": [],
      "iterations": [
        {
          "n": 1,
          "phase": "building",
          "steps_completed": [1, 2, 3, 4],
          "duration_ms": 182000,
          "tokens": { "input": 45000, "output": 12000 }
        }
      ]
    }
  }
}
```

### Field Reference

| Field | Type | Description |
|-------|------|-------------|
| `version` | number | Schema version, always `1` |
| `plan_file` | string | Path to the plan file |
| `worktree` | string\|null | Path to worktree directory if using worktree isolation |
| `branch` | string | Git branch name for this build |
| `pr_number` | number\|null | GitHub PR number once created |
| `pr_url` | string\|null | GitHub PR URL once created |
| `status` | enum | Current build status |
| `mode` | enum | `"thorough"` or `"quick"` |
| `model` | string | Provider/model ID used for this build |
| `context_budget` | number | Steps per @build invocation |
| `phase` | enum | Current pipeline phase |
| `total_steps` | number | Total steps in the plan |
| `completed_steps` | number | Steps completed so far |
| `current_step` | number | Step currently being worked on |
| `task_id` | string\|null | Subagent session ID for warm resume |
| `started_at` | ISO 8601 | When the build started |
| `last_activity_at` | ISO 8601 | Last checkpoint timestamp |
| `error` | string\|null | Error description if status is `"error"` |
| `budget` | number\|null | User's cost budget in dollars |
| `estimated_cost` | number | Running cost total in dollars |
| `cost_per_iteration` | array | Per-turn cost estimates |
| `iterations` | array | Detailed log of each dispatch iteration |

## Recovery Dashboard Format

```
╔══════════════════════════════════════════════════════════════╗
║  📋 SESSION RECOVERY                                         ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  {for each build with status != "complete":}                 ║
║  {icon} {name}  {progress_bar}  {completed}/{total}  {status}║
║     Branch: {branch-name} · {time_ago}                       ║
║     {if error: Error: {description}}                         ║
║                                                              ║
║  Commands: "resume {name}" · "abort {name}" · "status"       ║
╚══════════════════════════════════════════════════════════════╝
```

Status icons: ⏸️ paused, 🔄 planning, 🏗️ building, ✅ complete, ❌ error

## Abort Behavior

When the user says "abort {name}": Set the build's status to "paused" in loop-state.json. Report the branch name and completed step count so the user can review partial work. Do NOT delete the plan file or branch — the user may want to resume later or inspect what was built. Confirm: "⏸️ Build {name} paused at step {n}/{total}. Branch {branch-name} preserved."

## Status Command

If the user says "status" at any time, read loop-state.json and all active plan files. Show a condensed report for each active build: name, status, steps done/total, current phase, last activity time, estimated cost spent (if budget tracking is active). If no active builds, respond: "No active builds."

## Cost Budget

Users can set a cost budget for any plan or build by saying things like "spend $5 on this", "budget: $10", or "keep it cheap" (implies ~$2).

### How it works

1. **Estimate before starting**: When entering the Planning or Build pipeline, call `model_context` to get cost estimates. Multiply `est_cost_per_step` by total steps and `est_cost_per_plan_turn` by estimated planning turns. If the estimate exceeds the user's budget by more than 2x, warn immediately: "This looks like it'll cost ~${est}. Your budget is ${budget}. Want to proceed, reduce scope, or increase budget?"

2. **Track during execution**: After each subagent dispatch, estimate tokens used this turn from iteration stats in loop-state. Update a running `estimated_cost` field in the build's loop-state entry. Formula: `cost = (input_tokens × input_rate + output_tokens × output_rate) / 1,000,000`.

3. **Warn at 80%**: When estimated_cost reaches 80% of budget, report to user: "⚠️ Budget update: ~${spent} of ${budget} used ({pct}%). ~{remaining_steps} steps remain. Continue?"

4. **Ask at limit**: If the build needs to go slightly over budget (up to ~25%) to complete a logical unit of work, ask: "We're at ${spent} of your ${budget} budget, but Step {n} is almost done. OK to finish this step (~${est_extra} more)?"

5. **Default**: If no budget is specified, there is no limit — but always show estimated cost in checkpoint reports so the user has visibility.

6. **Never hard-stop mid-step**: A step in progress should always be allowed to complete. Budget checks happen between steps, not during.

### Cost fields in loop-state.json

Add to each build entry:
- `budget`: null or number (user's budget in dollars)
- `estimated_cost`: number (running total in dollars)
- `cost_per_iteration`: array of per-turn cost estimates
