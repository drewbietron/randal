import { tool } from "@opencode-ai/plugin"
import path from "node:path"

const readTool = tool({
  description: "Read the current loop state from .opencode/loop-state.json. Returns all active, paused, errored, and completed builds.",
  args: {},
  async execute(_args, context) {
    const file = path.join(context.worktree, ".opencode", "loop-state.json")
    try {
      const content = await Bun.file(file).text()
      return content
    } catch {
      return JSON.stringify({ version: 1, builds: {} }, null, 2)
    }
  },
})

const writeTool = tool({
  description:
    "Update the loop state in .opencode/loop-state.json. Pass the full builds object. Use this to track active builds, record progress, mark completion, or log errors.",
  args: {
    builds: tool.schema
      .string()
      .describe("JSON string of the full builds object to write"),
  },
  async execute(args, context) {
    const dir = path.join(context.worktree, ".opencode")
    const file = path.join(dir, "loop-state.json")
    await Bun.$`mkdir -p ${dir}`
    const state = { version: 1, builds: JSON.parse(args.builds) }
    await Bun.write(file, JSON.stringify(state, null, 2))
    return `Loop state saved to ${file}`
  },
})

export const loop_state_read = readTool
export const loop_state_write = writeTool
