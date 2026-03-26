import { tool } from "@opencode-ai/plugin";

export default tool({
	description:
		"Get the current model's context window size and calculate step budgets for subagent dispatch. Returns context limit, effective working window, and recommended steps per invocation for both planning and building.",
	args: {
		provider_id: tool.schema.string().describe("Provider ID (e.g., 'anthropic')"),
		model_id: tool.schema.string().describe("Model ID (e.g., 'claude-opus-4-20260315')"),
	},
	async execute(args, _context) {
		// Try to fetch from OpenCode's local server
		try {
			const res = await fetch("http://127.0.0.1:19432/config/providers");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();

			const provider = data.providers?.find(
				(p: Record<string, unknown>) => p.id === args.provider_id,
			);
			if (!provider) {
				return fallback(`Provider '${args.provider_id}' not found`);
			}

			const model = provider.models?.[args.model_id];
			if (!model) {
				return fallback(`Model '${args.model_id}' not found in provider '${args.provider_id}'`);
			}

			const contextLimit = model.limit?.context ?? 0;
			const outputLimit = model.limit?.output ?? 0;

			return calculate(contextLimit, outputLimit, `${args.provider_id}/${args.model_id}`);
		} catch (e) {
			return fallback(`Could not reach OpenCode server: ${e}`);
		}
	},
});

const PRICING: Record<string, { input: number; output: number }> = {
	// Prices per 1M tokens
	"claude-opus": { input: 15, output: 75 },
	"claude-sonnet": { input: 3, output: 15 },
	"claude-haiku": { input: 0.25, output: 1.25 },
	"gpt-4o": { input: 2.5, output: 10 },
	"gpt-4o-mini": { input: 0.15, output: 0.6 },
	"gpt-4.1": { input: 2, output: 8 },
	"gpt-4.1-mini": { input: 0.4, output: 1.6 },
	"gpt-4.1-nano": { input: 0.1, output: 0.4 },
	o3: { input: 2, output: 8 },
	"o4-mini": { input: 1.1, output: 4.4 },
	"gemini-2.5-pro": { input: 1.25, output: 10 },
	"gemini-2.5-flash": { input: 0.15, output: 0.6 },
	default: { input: 5, output: 15 },
};

function lookupPricing(modelName: string): { input: number; output: number } {
	const lower = modelName.toLowerCase();
	for (const [key, price] of Object.entries(PRICING)) {
		if (key !== "default" && lower.includes(key)) return price;
	}
	return PRICING.default;
}

function calculate(contextLimit: number, outputLimit: number, modelName: string) {
	// Conservative: 40% of context is the effective working window
	// (system prompt ~15%, tool descriptions ~10%, agent instructions ~5%, buffer ~10%)
	const effectiveWindow = Math.floor(contextLimit * 0.4);

	// Average tokens per step (read file + think + edit + verify)
	const tokensPerStep = 15000;

	// Calculate steps per invocation, clamped 1-6
	const rawSteps = Math.floor(effectiveWindow / tokensPerStep);
	const stepsPerBuildInvocation = Math.max(1, Math.min(6, rawSteps));

	// Planning budgets (reading is cheaper than editing)
	const filesPerDiscoveryTurn = stepsPerBuildInvocation * 2;
	const stepsPerDraftingTurn = stepsPerBuildInvocation;

	// Determine tier for reference
	const tier = contextLimit >= 128000 ? 1 : contextLimit >= 48000 ? 2 : 3;

	const pricing = lookupPricing(modelName);
	// Estimated tokens per step: ~15K input (read file + context) + ~5K output (edits + reasoning)
	const estInputPerStep = 15000;
	const estOutputPerStep = 5000;
	const estCostPerStep =
		(estInputPerStep * pricing.input + estOutputPerStep * pricing.output) / 1_000_000;
	// Planning turns use more input (reading), less output
	const estInputPerPlanTurn = 20000;
	const estOutputPerPlanTurn = 10000;
	const estCostPerPlanTurn =
		(estInputPerPlanTurn * pricing.input + estOutputPerPlanTurn * pricing.output) / 1_000_000;

	return JSON.stringify(
		{
			model: modelName,
			context_limit: contextLimit,
			output_limit: outputLimit,
			effective_window: effectiveWindow,
			tier: tier,
			budget: {
				build_steps_per_invocation: stepsPerBuildInvocation,
				plan_files_per_discovery_turn: filesPerDiscoveryTurn,
				plan_steps_per_drafting_turn: stepsPerDraftingTurn,
			},
			cost: {
				input_per_1m: pricing.input,
				output_per_1m: pricing.output,
				est_cost_per_step: Math.round(estCostPerStep * 1000) / 1000,
				est_cost_per_plan_turn: Math.round(estCostPerPlanTurn * 1000) / 1000,
			},
			note:
				tier === 3
					? "Small context model — use 1 step per invocation, checkpoint aggressively"
					: tier === 2
						? "Medium context model — conservative budgets, checkpoint after each small batch"
						: "Large context model — comfortable budgets, but still checkpoint for fresh context",
			context_strategy: tier === 1 ? "compact" : "reset",
			session_length: tier === 1 ? "long" : tier === 2 ? "medium" : "short",
		},
		null,
		2,
	);
}

function fallback(reason: string) {
	return JSON.stringify(
		{
			model: "unknown",
			context_limit: 0,
			output_limit: 0,
			effective_window: 0,
			tier: 2,
			budget: {
				build_steps_per_invocation: 3,
				plan_files_per_discovery_turn: 6,
				plan_steps_per_drafting_turn: 3,
			},
			cost: {
				input_per_1m: 5,
				output_per_1m: 15,
				est_cost_per_step: 0.15,
				est_cost_per_plan_turn: 0.25,
			},
			note: `Fallback to Tier 2 defaults. Reason: ${reason}`,
			warning: reason,
			context_strategy: "reset",
			session_length: "medium",
		},
		null,
		2,
	);
}
