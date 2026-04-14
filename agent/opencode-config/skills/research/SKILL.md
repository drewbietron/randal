---
name: research
description: Systematic research workflow for multi-source investigation, synthesis, and documentation. Supports resumable, overnight research projects with structured deliverables.
---

# Research Skill

## When to Use

Load this skill when the user's request matches one of these patterns:
- **Explicit research requests**: "research X", "investigate Y", "explore Z"
- **Questions requiring synthesis**: "What are the best practices for...", "How does X compare to Y..."
- **Deep dives**: "Give me a comprehensive overview of...", "I need to understand..."
- **Technology evaluation**: "Should we use X or Y?", "What are the tradeoffs..."
- **Investigations that might take hours/days**: Multi-part questions, complex domains

**Do NOT use for**:
- Simple factual questions (use webfetch or tavily_tavily_search directly)
- Codebase exploration (use @explore subagent)
- Planning or building code changes (use planning/building skills)

## Research Project Structure

All research projects are saved in `.opencode/research/{slug}_{YYYYMMDD_HHMMSS}/`:

```
.opencode/research/agent-memory-patterns_20260414_093000/
├── research.md           # Main deliverable (generated)
├── state.json           # Research progress tracking
├── sources/             # Raw source material
│   ├── web_001.md      # Web research results
│   ├── code_001.md     # Codebase findings
│   └── experiments_001.md  # Experimental results
└── artifacts/          # Supporting files (optional)
    ├── diagrams/
    └── data/
```

## Workflow Phases

### Phase 1: Scoping (You ⟷ User)

**Goal**: Clarify research question, boundaries, and success criteria

1. **Parse the research question** from the user's message
2. **Ask 2-4 scoping questions** (only in thorough mode):
   - What's the primary goal? (Understanding, decision-making, evaluation, documentation)
   - What's the scope? (Specific technologies, time period, constraints)
   - What's the output format? (Report, comparison table, recommendations, deep dive)
   - Any existing knowledge or context I should be aware of?
3. **Create research project**:
   ```bash
   slug={generate slug from question}
   dir=.opencode/research/{slug}_{YYYYMMDD_HHMMSS}
   mkdir -p $dir/sources $dir/artifacts
   ```
4. **Initialize state.json**:
   ```json
   {
     "question": "Original research question",
     "scope": "Clarified scope and boundaries",
     "goal": "primary_goal",
     "status": "scoped",
     "subquestions": [],
     "sources_found": 0,
     "findings_count": 0,
     "started_at": "ISO timestamp",
     "updated_at": "ISO timestamp"
   }
   ```
5. **Initialize research.md** with header:
   ```markdown
   # Research: {Title}
   
   **Question**: {Original question}
   **Scope**: {Clarified scope}
   **Started**: {Date}
   **Status**: In Progress
   
   ---
   
   ## Executive Summary
   _To be completed_
   
   ## Research Questions
   - [ ] {Subquestion 1}
   - [ ] {Subquestion 2}
   ...
   ```

### Phase 2: Investigation (You ⟷ @research agent, Autonomous)

**Goal**: Systematically gather information from multiple sources

This is the core autonomous loop. You dispatch a @research subagent (using the `task` tool with `subagent_type: "general"`), which:

1. **Reads current state** from `state.json`
2. **Picks next subquestion** from the list (or generates more if needed)
3. **Multi-source search** (run in parallel):
   - `tavily_tavily_research({ input: subquestion, model: "pro" })` for comprehensive web research
   - `tavily_tavily_search({ query: subquestion, search_depth: "advanced" })` for specific facts
   - `memory_search({ query: subquestion })` to check past learnings
   - If code-related: `glob` + `read` + `grep` for codebase investigation
   - If tool/API-related: `tavily_tavily_skill({ query: subquestion })` for documentation
4. **Save raw sources** to `sources/web_{n}.md` or `sources/code_{n}.md`
5. **Extract key findings** (bullet points, quotes, insights)
6. **Update state.json**: Mark subquestion complete, increment counters
7. **Checkpoint**: Return findings and progress to you

**Dispatch template**:
```
You are @research, a systematic research agent.

Research project: .opencode/research/{slug}_{timestamp}/
Current phase: Investigation

CONTEXT BUDGET: Investigate 1-3 subquestions this turn (depending on complexity).

Your task:
1. Read state.json to see current progress
2. Pick the next unanswered subquestion(s)
3. Use all available research tools in parallel:
   - tavily_tavily_research for comprehensive synthesis
   - tavily_tavily_search for specific facts
   - memory_search for past learnings
   - glob/read/grep if code-related
   - webfetch if you need to read specific URLs
4. Save raw sources to sources/ directory
5. Extract key findings (3-7 bullet points per subquestion)
6. Update state.json with progress
7. Checkpoint and return your findings

Available tools: tavily_* ✅ · memory_* {yes/no} · bash (read-only) ✅ · webfetch ✅

When you've investigated your budget of subquestions, checkpoint with:
RESEARCH_CHECKPOINT: {n} subquestions investigated, {m} findings extracted
```

**Your loop**:
1. Dispatch @research
2. Parse checkpoint (look for `RESEARCH_CHECKPOINT:` header)
3. Report progress to user:
   ```
   🔬 Research update: {slug}
      Investigated: {questions answered}/{total questions}
      Sources gathered: {n} web, {m} code, {k} memory
      Key findings: {x} new insights
      
      Continuing investigation...
   ```
4. Emit progress tag: `<progress>Research: {n}/{total} questions investigated</progress>`
5. Update loop-state.json
6. Re-invoke @research
7. Repeat until all subquestions answered OR user interrupts

### Phase 3: Synthesis (You, Interactive)

**Goal**: Compile findings into a coherent deliverable

1. **Read all sources** from `sources/` directory
2. **Read state.json** for structured findings
3. **Generate research.md** with:
   - **Executive Summary** (3-5 paragraphs): What you learned, key insights, recommendations
   - **Key Findings** (numbered list): Top 5-10 takeaways
   - **Detailed Analysis**: Per subquestion breakdown with supporting evidence
   - **Sources Cited**: All sources with titles and URLs
   - **Open Questions**: Things you couldn't answer or need further investigation
   - **Recommendations** (if applicable): Actionable next steps
4. **Update state.json**: `"status": "complete"`
5. **Store key findings in memory**:
   ```
   memory_store({
     content: "Research: {slug}. Key finding: {insight}",
     category: "lesson",
     source: "self"
   })
   ```
6. **Present to user**:
   ```
   🔬 Research complete: {slug}
      
      Executive Summary:
      {2-3 sentence summary}
      
      Full report: .opencode/research/{slug}_{timestamp}/research.md
      Sources: {n} web, {m} code, {k} memory
      Key findings: {x} insights
   ```

## Quick Mode

In **quick mode**:
- Skip scoping questions (use defaults)
- Single @research turn with aggressive parallel search
- 3-5 subquestions max
- Synthesis immediately after investigation
- Target: <10 minutes total

## Resumption

If research is interrupted (user stops, system crash, overnight run):

1. **Detect existing research project**: Look for `state.json` with `"status": "investigating"`
2. **Resume from last checkpoint**: Read state.json, see which subquestions are done
3. **Continue investigation loop**: Pick up where you left off
4. **On completion**: Run synthesis phase

## Context Injection

During long research runs, periodically call `context_check()` to see if user sent follow-up messages (e.g., "also look into X", "skip Y, focus on Z").

## Memory Integration

**Before starting research**: Always search memory for related past work:
```
memory_search("research {topic}")
memory_search("{key terms from question}")
```

**After completing research**: Store 3-5 key learnings:
```
memory_store({
  content: "Research on {topic}: {key insight}",
  category: "lesson",
  source: "self"
})
```

## Struggle Detection

If @research returns 3+ times with no new findings, or sources keep returning "not found":
1. Call `struggle_check({ iterations_without_progress: N, recent_errors: 0 })`
2. If struggling, pivot strategy:
   - Rephrase subquestions
   - Try different search terms
   - Broaden or narrow scope
   - Ask user for guidance

## Example Usage

**User**: "Research best practices for agent memory systems"

**You**:
1. Load skill("research")
2. Scoping phase: Ask 2-3 questions about scope, goal, output format
3. Create project: `.opencode/research/agent-memory-best-practices_20260414_093000/`
4. Break into subquestions: "How do existing agents store memory?", "What are the tradeoffs of different approaches?", "What patterns emerge from production systems?"
5. Investigation loop: Dispatch @research 3-4 times, gathering 20+ sources
6. Synthesis: Compile comprehensive report
7. Present findings + save to memory

**Output**: `research.md` with executive summary, 8 key findings, detailed analysis, 25 sources cited, 4 recommendations

## Cost Awareness

- Estimate tokens per research turn: ~50K for comprehensive research (tavily_tavily_research is expensive)
- Warn user if research will exceed 500K tokens
- Offer to do "quick mode" research instead

## When to Use Each Tavily Tool

- **tavily_tavily_research**: Big picture questions, "What is X?", "How does Y work?", needs synthesis from 10+ sources
- **tavily_tavily_search**: Specific facts, "What's the syntax for...", "When was X released?", 3-5 sources enough
- **tavily_tavily_skill**: Documentation lookup for libraries/APIs, "How do I use celery beat?", constrained to official docs
- **tavily_tavily_extract**: You already have URLs, just need clean content
- **tavily_tavily_crawl**: Need to map out a specific site's structure

## Integration with Other Skills

- **Research feeds into Planning**: After research, user might say "now let's build it" → transition to planning skill
- **Research can call @explore**: For codebase-specific questions, dispatch @explore subagent instead of doing it yourself
- **Research uses Memory**: Both search (to avoid re-researching) and store (to remember findings)
