---
globs: "**"
description: Before pushing code or creating PRs, always discover and run the repository's CI checks locally. Never push directly to main.
---

# Pre-Push CI Rules

## Before every push or PR, run the repo's CI checks locally

### Step 1: Discover what CI runs
Look for CI configuration in the repository:
- `.github/workflows/*.yml` — GitHub Actions
- `.gitlab-ci.yml` — GitLab CI
- `.circleci/config.yml` — CircleCI
- `Jenkinsfile` — Jenkins
- `bitbucket-pipelines.yml` — Bitbucket

Read the CI config to find the actual commands (lint, typecheck, test, build).

### Step 2: Run those commands locally
Execute the same commands that CI will run. Common patterns:
- `bun run lint` or `npm run lint` — linting/formatting
- `bun run typecheck` or `tsc --noEmit` — type checking
- `bun test` or `npm test` — test suite
- `bun run build` or `npm run build` — build step (if CI runs it)

### Step 3: Fix any failures BEFORE pushing
If lint fails, auto-fix it. If tests fail, fix them. If typecheck fails, fix the types. Do NOT push code that will fail CI — catch it locally first.

### Step 4: Only then push
Once all checks pass locally, push the branch and create the PR.

## Never push directly to main

- Always create a feature/fix branch
- Always create a PR
- Let CI validate on the PR before merging
- The only exception: the user explicitly says "push to main" or "skip the PR"

## When deploying to test environments (Railway, etc.)
- Deploy from the feature branch, NOT from main
- Only merge to main after the feature branch is confirmed working
- This prevents broken code from reaching main

## When working on unfamiliar repos
If you don't know the CI commands:
1. Check `package.json` scripts section for `lint`, `test`, `typecheck`, `check`, `ci` scripts
2. Check the CI workflow files for the exact commands
3. If no CI config exists, at minimum run the test suite if one exists
4. Ask the user if unsure what checks to run
