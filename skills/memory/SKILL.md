---
name: memory
description: How to use Randal's persistent memory system. Save learnings, preferences, patterns, and facts to MEMORY.md so they are indexed and searchable across conversations.
---

# Memory — Persistent Knowledge

You have a persistent memory backed by a searchable database. Anything you write to `MEMORY.md` is automatically indexed and will be available in future conversations.

## How It Works

1. You write entries to `MEMORY.md` in the project root
2. A file watcher detects changes and indexes them into the memory store
3. On future requests, relevant memories are automatically injected into your context
4. You can search your own memory for specific topics

## Format

Write memories as categorized bullet points:

```markdown
- [preference] User prefers concise responses without emoji
- [pattern] This repo uses Bun for testing, not Jest
- [fact] The Discord bot token is stored in .env as DISCORD_BOT_TOKEN
- [lesson] Always run `bun test` before committing — pre-commit hooks are strict
- [skill-outcome] steer OCR works better than accessibility tree for Electron apps
- [escalation] User wants to be notified if a deploy fails
```

### Categories

| Category | When to use |
|----------|------------|
| `preference` | User preferences, communication style, workflow choices |
| `pattern` | Recurring patterns in the codebase or workflow |
| `fact` | Important facts about the project, infrastructure, or environment |
| `lesson` | Something learned from a mistake or success |
| `skill-outcome` | Results from using a specific tool or approach |
| `escalation` | Things that need human attention or notification |

## When to Save

**Always save when you learn something that would be useful in a future conversation:**

- User corrects you or expresses a preference
- You discover something non-obvious about the project
- A tool or approach works particularly well (or badly)
- You learn about the user's role, expertise, or responsibilities
- You encounter a bug, workaround, or configuration detail

**Ask the user before saving when:**

- You're unsure if the information is worth remembering
- The information might be temporary or context-specific
- You want to confirm your understanding is correct

**Don't save:**

- Information that's obvious from reading the code
- Ephemeral state (current task progress, temporary debugging info)
- Anything already in git history or documentation

## How to Save

Append to `MEMORY.md` — don't overwrite existing content:

```bash
echo "- [lesson] Always check steer focus before typing into a field" >> MEMORY.md
```

Or read the file, add your entries, and write it back.

## How to Read

Your relevant memories are automatically included in your context. If you need to search for something specific, read MEMORY.md directly.
