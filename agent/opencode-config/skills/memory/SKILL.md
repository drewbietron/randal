---
name: memory
description: How to use Randal's persistent memory system. Memories are stored in Meilisearch and automatically injected into context based on relevance.
---

# Memory — Persistent Knowledge

You have persistent, searchable memory backed by Meilisearch. Memories survive across all conversations and can be shared across posse members.

## How It Works

1. You save memories using categorized entries via the memory API
2. Memories are indexed in Meilisearch with full-text search
3. On future requests, relevant memories are automatically injected into your context
4. When a posse is configured, memories can be shared across agents

## Categories

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

## How to Read

Your relevant memories are automatically included in your context based on the current request. You don't need to search for them manually.
