# CI Integration Tests (Railway)

End-to-end smoke tests that deploy Randal to Railway, run HTTP API checks against the live instance, and tear down afterwards. This catches deployment config issues, API routing failures, and scheduler problems that unit tests cannot cover.

## Required GitHub Secrets

| Secret | Required | Description |
| --- | --- | --- |
| `RAILWAY_TOKEN` | Yes | Railway API token with project create/delete permissions |
| `OPENROUTER_API_KEY` | Optional | Needed for the job submission test (`POST /job`). Tests still pass without it but the job test is skipped. |

### How to get a Railway token

**From the Railway dashboard:**

1. Go to [railway.app](https://railway.app) and sign in.
2. Open **Account Settings > Tokens**.
3. Create a new token with a descriptive name (e.g., `github-ci`).
4. Copy the token and add it as a GitHub Actions secret.

**From the CLI:**

```bash
railway login --browserless
# Follow the prompts, then copy the token from ~/.railway/config.json
```

### Adding secrets to GitHub

1. Go to your repository on GitHub.
2. Navigate to **Settings > Secrets and variables > Actions**.
3. Click **New repository secret**.
4. Add `RAILWAY_TOKEN` (and optionally `OPENROUTER_API_KEY`).

## When the workflow triggers

The integration test workflow (`.github/workflows/integration-test.yml`) runs in two cases:

1. **Pull requests** that modify deployment-relevant files:
   - `Dockerfile`
   - `docker/**`
   - `packages/gateway/**`, `packages/runner/**`, `packages/scheduler/**`, `packages/cli/**`, `packages/core/**`
   - `randal.config.railway.yaml`, `randal.config.ci.yaml`
   - `tests/integration/smoke.sh`
   - `.github/workflows/integration-test.yml`

2. **Manual trigger** via the GitHub Actions UI (`workflow_dispatch`).

It does **not** run on every PR -- only when files that affect the deployed artifact change.

## What the workflow does

1. Checks out the repository.
2. Installs the Railway CLI.
3. Creates an ephemeral Railway project (`randal-ci-<run_id>`).
4. Sets environment variables (auto-generated auth tokens, CI config).
5. Deploys with `railway up -d`.
6. Polls `/health` every 10s for up to 5 minutes until the deployment is healthy.
7. Runs `tests/integration/smoke.sh` against the live URL.
8. **Always** tears down the Railway project (even on test failure).
9. Posts a results summary to the GitHub Actions step summary.

## How to manually trigger via GitHub Actions UI

1. Go to the repository on GitHub.
2. Click the **Actions** tab.
3. Select **Integration Tests (Railway)** from the workflow list.
4. Click **Run workflow**.
5. Select the branch to test and click **Run workflow**.

## Running smoke tests locally

You can run the smoke tests against any live Randal deployment. The script only needs `curl` and `jq`.

### Against the existing Railway deployment

```bash
BASE_URL=https://randal-single-agent-production.up.railway.app \
AUTH_TOKEN=randal-api-token \
bash tests/integration/smoke.sh
```

### Against a local instance

```bash
# Start Randal locally first, then:
BASE_URL=http://localhost:7600 \
AUTH_TOKEN=your-local-token \
bash tests/integration/smoke.sh
```

### Against a manual Railway deploy

```bash
# Deploy manually
railway up -d

# Get the URL
DEPLOY_URL=$(railway domain)

# Run tests
BASE_URL="https://$DEPLOY_URL" \
AUTH_TOKEN="your-token" \
bash tests/integration/smoke.sh
```

## Test coverage

The smoke script tests 12 endpoints:

| # | Test | Endpoint | Auth |
| --- | --- | --- | --- |
| 1 | Health check | `GET /health` | No |
| 2 | Instance info | `GET /instance` | Yes |
| 3 | Submit job | `POST /job` | Yes |
| 4 | Get job | `GET /job/:id` | Yes |
| 5 | List jobs | `GET /jobs` | Yes |
| 6 | Posse (404 expected) | `GET /posse` | Yes |
| 7 | Scheduler status | `GET /scheduler` | Yes |
| 8 | Create cron job | `POST /cron` | Yes |
| 9 | List cron jobs | `GET /cron` | Yes |
| 10 | Delete cron job | `DELETE /cron/:name` | Yes |
| 11 | Sanitized config | `GET /config` | Yes |
| 12 | SSE event stream | `GET /events` | Yes |

## Troubleshooting

**Workflow is skipped / doesn't run:**
- The `RAILWAY_TOKEN` secret may not be configured. The workflow has an `if` guard that skips when the token is empty.

**Deploy times out:**
- Railway Docker builds can be slow on first run (no cache). The workflow waits up to 5 minutes. If builds consistently exceed this, consider optimizing the Dockerfile layers.

**SSE test fails:**
- The SSE ping fires every 15 seconds. The test allows 20 seconds. If the server is under load, the ping may arrive late. This is the most flaky test.

**Orphaned Railway projects:**
- The teardown step uses `if: always()` and only runs when project creation succeeded. If you suspect orphans, list projects with `railway project list` and delete any `randal-ci-*` projects.
