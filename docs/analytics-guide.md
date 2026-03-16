# Analytics & Self-Learning Guide

The `@randal/analytics` package lets Randal learn from its own work. Every
completed job can be annotated with a quality signal, building up reliability
scores, domain categorization, and actionable recommendations over time.

---

## How it works

```
Job completes ──► Annotation ──► Scoring engine ──► Domain categorizer
                                       │                    │
                                       ▼                    ▼
                              Reliability scores    Recommendations
                                       │                    │
                                       └────────┬───────────┘
                                                ▼
                                       Feedback injection
                                     (into future prompts)
```

1. A job finishes and produces an outcome.
2. An **annotation** records whether the outcome was good, bad, or somewhere
   in between.
3. The **scoring engine** updates per-domain reliability scores.
4. The **domain categorizer** tags the job based on keyword analysis.
5. The **recommendation engine** identifies patterns and suggests
   improvements.
6. **Feedback injection** weaves relevant scores and recommendations into
   future runner prompts so Randal improves over time.

---

## Annotation workflow

Annotations are the raw input to the analytics system. There are three ways
to create them:

### 1. Via the gateway API

```bash
curl -X POST http://localhost:7600/api/annotations \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jobId": "job_abc123",
    "score": 0.9,
    "notes": "Completed correctly, clean code",
    "tags": ["frontend", "react"]
  }'
```

Fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `jobId` | string | yes | The job to annotate |
| `score` | number (0-1) | yes | Quality score: 0 = failure, 1 = perfect |
| `notes` | string | no | Free-text explanation |
| `tags` | string[] | no | Manual domain tags (override auto-detection) |

### 2. Via a channel message

From any connected channel (Discord, Slack, iMessage, etc.), reply to a job
result with a rating:

```
@randal rate 0.8 good solution but missed edge case
```

The gateway parses the rating command, extracts the score and notes, and
creates an annotation for the most recent job in that conversation.

### 3. Via the MCP server

When the runner's MCP server is enabled, the `annotate` tool is available
directly within the agent session:

```json
{
  "tool": "annotate",
  "arguments": {
    "score": 0.7,
    "notes": "Partially correct — tests were missing"
  }
}
```

This enables auto-annotation: the runner can evaluate its own output at the
end of a job (controlled by `autoAnnotationPrompt`).

### Auto-annotation

When `analytics.autoAnnotationPrompt` is `true` (the default), the runner
appends a self-evaluation step at the end of each job. The agent rates its
own work and submits an annotation automatically. Human annotations always
take precedence and overwrite auto-annotations for the same job.

---

## Reliability scoring

Reliability scores are per-domain floating-point values between 0 and 1. They
answer the question: *"How reliably does this instance handle work in domain
X?"*

### Calculation

Scores use an exponentially-weighted moving average with aging:

```
new_score = α × latest_annotation + (1 - α) × previous_score
```

Where `α` is derived from the `agingHalfLife` setting (default: 30 days).
Recent annotations weigh more than old ones, so the score reflects current
capability rather than historical averages.

### Aging

Scores decay toward 0.5 (neutral) over time if no new annotations arrive for
a domain. The half-life controls how fast:

| `agingHalfLife` | Effect |
|----------------|--------|
| 7 | Aggressive — scores become stale after ~2 weeks |
| 30 (default) | Moderate — scores stay relevant for ~2 months |
| 90 | Conservative — scores persist for ~6 months |

### Viewing scores

```bash
$ randal analytics scores

Reliability Scores
────────────────────────────────────────────
Domain          Score    Samples    Trend
────────────────────────────────────────────
frontend        0.91     34         ↑
backend         0.85     28         →
testing         0.78     12         ↑
infra           0.65     8          ↓
database        0.72     6          →
docs            0.94     15         →
────────────────────────────────────────────
Overall: 0.83 (103 annotations)
```

---

## Domain categorization

Every job is automatically categorized into one or more domains based on
keyword matching against the prompt and file paths involved. The default
keyword map:

```yaml
analytics:
  domainKeywords:
    frontend:
      - react
      - vue
      - angular
      - css
      - html
      - component
      - ui
      - ux
      - tailwind
      - next.js
      - svelte
    backend:
      - api
      - server
      - endpoint
      - rest
      - graphql
      - middleware
      - express
      - hono
      - fastify
    database:
      - sql
      - query
      - migration
      - schema
      - postgres
      - mysql
      - sqlite
      - prisma
      - drizzle
    infra:
      - docker
      - kubernetes
      - ci
      - cd
      - deploy
      - terraform
      - aws
      - gcp
      - azure
      - nginx
    docs:
      - readme
      - documentation
      - docs
      - guide
      - tutorial
      - changelog
    testing:
      - test
      - spec
      - jest
      - vitest
      - cypress
      - playwright
      - coverage
```

You can add or override domains by extending this map in your config. Manual
`tags` on annotations always take precedence over auto-detection.

---

## Recommendation engine

The recommendation engine analyzes annotation patterns and generates
actionable suggestions:

### Types of recommendations

| Type | Example |
|------|---------|
| **Strength** | "Frontend tasks have a 0.91 reliability score — consider routing more UI work here" |
| **Weakness** | "Infra tasks score 0.65 with a downward trend — consider adding infra-specific skills or routing to a specialized instance" |
| **Skill gap** | "Database migrations consistently score below 0.7 — a migration-specific skill file may help" |
| **Routing** | "This instance handles backend well (0.85) but frontend poorly (0.52) — enable mesh routing to delegate frontend work" |

### Frequency

```yaml
analytics:
  recommendationFrequency: weekly   # daily | weekly | on-demand
```

- **daily**: Recommendations regenerated every 24 hours.
- **weekly**: Regenerated every 7 days.
- **on-demand**: Only generated when explicitly requested via CLI or API.

### Viewing recommendations

```bash
$ randal analytics recommendations

Recommendations (generated 2025-03-14)
──────────────────────────────────────────────────────────
1. [strength] Frontend reliability is excellent (0.91, 34 samples).
   No action needed.

2. [weakness] Infra reliability has declined to 0.65 (8 samples, ↓).
   Consider adding skills/infra-best-practices.md or routing infra
   tasks to a specialized mesh instance.

3. [skill-gap] Database migration tasks average 0.68 across 4 samples.
   A dedicated migration skill with schema conventions may help.

4. [routing] Backend (0.85) and testing (0.78) are strong. Frontend
   tasks from other mesh instances could be accepted.
──────────────────────────────────────────────────────────
```

---

## Feedback injection

When `analytics.feedbackInjection` is `true` (the default), the runner
automatically injects relevant analytics context into the system prompt for
each new job. This includes:

- **Domain reliability score** for the detected domain(s).
- **Recent recommendations** relevant to the task.
- **Past failure patterns** if the domain has known weak spots.

The injected context looks like:

```
[Analytics Context]
Domain: frontend (reliability: 0.91, trend: ↑)
Note: You have strong frontend skills. Recent annotations show clean
component architecture is appreciated.

Domain: testing (reliability: 0.78, trend: ↑)
Note: Test coverage has been improving. Continue writing comprehensive
test cases.
```

This creates a feedback loop: annotations improve scores, scores influence
prompts, better prompts produce better outcomes, and better outcomes yield
higher annotation scores.

---

## CLI commands

### `randal analytics scores`

Display reliability scores for all domains.

```bash
randal analytics scores                    # all domains
randal analytics scores --domain frontend  # single domain
randal analytics scores --json             # JSON output
```

### `randal analytics recommendations`

View or regenerate recommendations.

```bash
randal analytics recommendations               # view current
randal analytics recommendations --regenerate  # force regeneration
randal analytics recommendations --json        # JSON output
```

### `randal analytics annotate`

Create an annotation from the CLI.

```bash
randal analytics annotate <jobId> --score 0.9 --notes "Clean implementation"
```

### `randal analytics history`

View annotation history.

```bash
randal analytics history                   # recent annotations
randal analytics history --domain backend  # filter by domain
randal analytics history --limit 50        # last 50
```

---

## Configuration reference

```yaml
analytics:
  # Master switch
  enabled: true

  # Auto-evaluate job quality at the end of each run
  autoAnnotationPrompt: true

  # Inject scores and recommendations into runner prompts
  feedbackInjection: true

  # How often to regenerate recommendations
  recommendationFrequency: weekly     # daily | weekly | on-demand

  # Domain keyword map for auto-categorization
  domainKeywords:
    frontend:
      - react
      - vue
      - css
      - component
    backend:
      - api
      - server
      - endpoint
    # ... add your own domains

  # Half-life in days for score aging
  agingHalfLife: 30
```

---

## Integration with mesh

When both `analytics` and `mesh` are enabled, reliability scores feed
directly into the mesh routing algorithm. The `reliability` routing weight
(default: 0.3) uses per-domain scores to prefer instances that have a proven
track record for the job's domain.

This means the mesh gets smarter over time without manual tuning — instances
that do well at frontend work naturally receive more frontend jobs.
