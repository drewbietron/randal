/**
 * Discord interactive component builders.
 * Pure factory functions — no side effects, fully testable.
 */
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	ModalBuilder,
	SlashCommandBuilder,
	SlashCommandStringOption,
	SlashCommandIntegerOption,
	SlashCommandBooleanOption,
	SlashCommandNumberOption,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
	TextInputBuilder,
	TextInputStyle,
} from "discord.js";
import type { Job, JobStatus, RandalConfig } from "@randal/core";

// ── Custom ID helpers ────────────────────────────────────────

/** Namespace all custom IDs to avoid collisions */
const PREFIX = "randal";

export function buttonId(action: string, jobId?: string): string {
	return jobId ? `${PREFIX}:${action}:${jobId}` : `${PREFIX}:${action}`;
}

export function parseButtonId(customId: string): { action: string; jobId?: string } | null {
	if (!customId.startsWith(`${PREFIX}:`)) return null;
	const parts = customId.split(":");
	if (parts.length === 2) return { action: parts[1] };
	if (parts.length >= 3) return { action: parts[1], jobId: parts.slice(2).join(":") };
	return null;
}

// ── Button builders ──────────────────────────────────────────

export function buildProgressButtons(jobId: string) {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(buttonId("stop", jobId))
			.setLabel("Stop")
			.setEmoji("🛑")
			.setStyle(ButtonStyle.Danger),
		new ButtonBuilder()
			.setCustomId(buttonId("context", jobId))
			.setLabel("Inject Context")
			.setEmoji("💉")
			.setStyle(ButtonStyle.Secondary),
		new ButtonBuilder()
			.setCustomId(buttonId("details", jobId))
			.setLabel("Details")
			.setEmoji("📋")
			.setStyle(ButtonStyle.Secondary),
	);
}

export function buildCompletionButtons(jobId: string) {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(buttonId("retry", jobId))
			.setLabel("Retry")
			.setEmoji("🔄")
			.setStyle(ButtonStyle.Secondary),
		new ButtonBuilder()
			.setCustomId(buttonId("save_memory", jobId))
			.setLabel("Save to Memory")
			.setEmoji("💾")
			.setStyle(ButtonStyle.Secondary),
	);
}

export function buildFailureButtons(jobId: string) {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(buttonId("retry", jobId))
			.setLabel("Retry")
			.setEmoji("🔄")
			.setStyle(ButtonStyle.Primary),
		new ButtonBuilder()
			.setCustomId(buttonId("resume", jobId))
			.setLabel("Resume")
			.setEmoji("▶️")
			.setStyle(ButtonStyle.Success),
		new ButtonBuilder()
			.setCustomId(buttonId("details", jobId))
			.setLabel("Details")
			.setEmoji("📋")
			.setStyle(ButtonStyle.Secondary),
	);
}

/** Disabled version of progress buttons for finalized messages */
export function buildDisabledProgressButtons(jobId: string) {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(buttonId("stop", jobId))
			.setLabel("Stop")
			.setEmoji("🛑")
			.setStyle(ButtonStyle.Danger)
			.setDisabled(true),
		new ButtonBuilder()
			.setCustomId(buttonId("context", jobId))
			.setLabel("Inject Context")
			.setEmoji("💉")
			.setStyle(ButtonStyle.Secondary)
			.setDisabled(true),
		new ButtonBuilder()
			.setCustomId(buttonId("details", jobId))
			.setLabel("Details")
			.setEmoji("📋")
			.setStyle(ButtonStyle.Secondary),
	);
}

export function buildDashboardRefreshButton() {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(buttonId("dashboard_refresh"))
			.setLabel("Refresh")
			.setEmoji("🔄")
			.setStyle(ButtonStyle.Secondary),
	);
}

// ── Job select menu ──────────────────────────────────────────

export function buildJobSelectMenu(jobs: Job[], action: "stop" | "details" | "resume") {
	const menu = new StringSelectMenuBuilder()
		.setCustomId(buttonId(`select_${action}`))
		.setPlaceholder(`Select a job to ${action}`);

	for (const job of jobs.slice(0, 25)) {
		const statusEmoji =
			job.status === "running"
				? "🔄"
				: job.status === "complete"
					? "✅"
					: job.status === "failed"
						? "❌"
						: job.status === "stopped"
							? "⏸️"
							: "⏳";
		menu.addOptions(
			new StringSelectMenuOptionBuilder()
				.setLabel(`${job.id.slice(0, 8)} — ${job.prompt.slice(0, 80)}`)
				.setDescription(`${job.status} — ${job.iterations.current}/${job.maxIterations} iterations`)
				.setValue(job.id)
				.setEmoji(statusEmoji),
		);
	}

	return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

// ── Embed builders ───────────────────────────────────────────

const COLORS = {
	running: 0x3498db, // blue
	complete: 0x2ecc71, // green
	failed: 0xe74c3c, // red
	stopped: 0xf39c12, // orange
	queued: 0x95a5a6, // gray
	dashboard: 0x9b59b6, // purple
} as const;

export function buildJobEmbed(job: Job) {
	const color = COLORS[job.status] ?? COLORS.queued;
	const statusEmoji =
		job.status === "running"
			? "🔄"
			: job.status === "complete"
				? "✅"
				: job.status === "failed"
					? "❌"
					: job.status === "stopped"
						? "⏸️"
						: "⏳";

	const embed = new EmbedBuilder()
		.setColor(color)
		.setTitle(`${statusEmoji} Job \`${job.id}\``)
		.setDescription(job.prompt.slice(0, 256))
		.addFields(
			{ name: "Status", value: job.status, inline: true },
			{
				name: "Iterations",
				value: `${job.iterations.current}/${job.maxIterations}`,
				inline: true,
			},
			{
				name: "Duration",
				value: job.duration ? `${job.duration}s` : "—",
				inline: true,
			},
		)
		.setTimestamp(new Date(job.createdAt));

	if (job.plan.length > 0) {
		const planText = job.plan
			.map((t) => {
				const icon =
					t.status === "completed"
						? "✅"
						: t.status === "in_progress"
							? "⏳"
							: t.status === "failed"
								? "❌"
								: "⬜";
				return `${icon} ${t.task}`;
			})
			.join("\n")
			.slice(0, 1024);
		embed.addFields({ name: "Plan", value: planText });
	}

	if (job.error) {
		embed.addFields({ name: "Error", value: `\`\`\`\n${job.error.slice(0, 512)}\n\`\`\`` });
	}

	return embed;
}

export function buildDashboardEmbed(opts: {
	activeJobs: Job[];
	recentJobs: Job[];
	memoryCount?: number;
	scheduleCount?: number;
	uptime?: string;
}) {
	const embed = new EmbedBuilder()
		.setColor(COLORS.dashboard)
		.setTitle("━━━━━━━━━ Randal Dashboard ━━━━━━━━━")
		.setTimestamp();

	const statusLine = `🟢 Online${opts.uptime ? ` | Uptime: ${opts.uptime}` : ""}`;
	embed.setDescription(statusLine);

	// Active jobs
	if (opts.activeJobs.length > 0) {
		const lines = opts.activeJobs.map((j) => {
			const iter = `${j.iterations.current}/${j.maxIterations}`;
			return `🔄 \`${j.id}\` — ${j.prompt.slice(0, 50)} (iter ${iter})`;
		});
		embed.addFields({ name: `Active Jobs (${opts.activeJobs.length})`, value: lines.join("\n") });
	} else {
		embed.addFields({ name: "Active Jobs", value: "None" });
	}

	// Recent jobs
	if (opts.recentJobs.length > 0) {
		const lines = opts.recentJobs.slice(0, 5).map((j) => {
			const emoji = j.status === "complete" ? "✅" : j.status === "failed" ? "❌" : "⏸️";
			const ago = formatTimeAgo(new Date(j.completedAt ?? j.createdAt));
			const dur = j.duration ? `${j.duration}s` : "";
			return `${emoji} \`${j.id}\` — ${j.prompt.slice(0, 40)} — ${ago}${dur ? ` (${dur})` : ""}`;
		});
		embed.addFields({ name: `Recent (${opts.recentJobs.length})`, value: lines.join("\n") });
	}

	// Footer stats
	const footerParts: string[] = [];
	if (opts.memoryCount !== undefined) footerParts.push(`Memory: ${opts.memoryCount} entries`);
	if (opts.scheduleCount !== undefined) footerParts.push(`Schedules: ${opts.scheduleCount} active`);
	if (footerParts.length > 0) {
		embed.setFooter({ text: footerParts.join(" | ") });
	}

	return embed;
}

function formatTimeAgo(date: Date): string {
	const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

// ── Modal builders ───────────────────────────────────────────

export function buildContextModal(jobId: string) {
	return new ModalBuilder()
		.setCustomId(buttonId("modal_context", jobId))
		.setTitle("Inject Context")
		.addComponents(
			new ActionRowBuilder<TextInputBuilder>().addComponents(
				new TextInputBuilder()
					.setCustomId("context_text")
					.setLabel("Context to send to the running agent")
					.setStyle(TextInputStyle.Paragraph)
					.setPlaceholder("e.g. Focus on the auth module, skip tests for now")
					.setRequired(true),
			),
		);
}

export function buildMemoryModal(defaultText?: string) {
	return new ModalBuilder()
		.setCustomId(buttonId("modal_memory"))
		.setTitle("Save to Memory")
		.addComponents(
			new ActionRowBuilder<TextInputBuilder>().addComponents(
				new TextInputBuilder()
					.setCustomId("memory_text")
					.setLabel("What to remember")
					.setStyle(TextInputStyle.Paragraph)
					.setValue(defaultText?.slice(0, 4000) ?? "")
					.setRequired(true),
			),
			new ActionRowBuilder<TextInputBuilder>().addComponents(
				new TextInputBuilder()
					.setCustomId("memory_category")
					.setLabel("Category (preference, pattern, fact, lesson)")
					.setStyle(TextInputStyle.Short)
					.setValue("fact")
					.setRequired(true),
			),
		);
}

// ── Slash command definitions ────────────────────────────────

export const SLASH_COMMANDS = [
	new SlashCommandBuilder()
		.setName("run")
		.setDescription("Submit a new job to Randal")
		.addStringOption((opt) =>
			opt.setName("prompt").setDescription("What should Randal do?").setRequired(true),
		),

	new SlashCommandBuilder()
		.setName("status")
		.setDescription("Check job status")
		.addStringOption((opt) =>
			opt.setName("job").setDescription("Job ID (omit for all active)").setRequired(false),
		),

	new SlashCommandBuilder().setName("jobs").setDescription("List recent jobs"),

	new SlashCommandBuilder()
		.setName("stop")
		.setDescription("Stop a running job")
		.addStringOption((opt) =>
			opt.setName("job").setDescription("Job ID (omit for most recent)").setRequired(false),
		),

	new SlashCommandBuilder()
		.setName("resume")
		.setDescription("Resume a failed or stopped job")
		.addStringOption((opt) =>
			opt.setName("job").setDescription("Job ID to resume").setRequired(true),
		),

	new SlashCommandBuilder()
		.setName("memory")
		.setDescription("Search or add to Randal's memory")
		.addSubcommand((sub) =>
			sub
				.setName("search")
				.setDescription("Search memory")
				.addStringOption((opt) =>
					opt.setName("query").setDescription("Search query").setRequired(true),
				),
		)
		.addSubcommand((sub) =>
			sub.setName("add").setDescription("Add a memory (opens a form)"),
		),

	new SlashCommandBuilder().setName("dashboard").setDescription("Show Randal status overview"),
];

// ── Thread name lifecycle helpers ────────────────────────────

export type ThreadLifecycleState = "started" | "running" | "complete" | "failed" | "stopped";

const LIFECYCLE_EMOJI: Record<ThreadLifecycleState, string> = {
	started: "🔄",
	running: "🔄",
	complete: "✅",
	failed: "❌",
	stopped: "⏸️",
};

export function buildThreadName(opts: {
	state: ThreadLifecycleState;
	topic: string;
	iteration?: number;
	maxIterations?: number;
	time?: string;
}): string {
	const emoji = LIFECYCLE_EMOJI[opts.state];
	const time = opts.time ?? formatTime();

	let prefix: string;
	if (
		opts.state === "running" &&
		opts.iteration !== undefined &&
		opts.maxIterations !== undefined &&
		opts.iteration > 1
	) {
		prefix = `${emoji} [${opts.iteration}/${opts.maxIterations}]`;
	} else {
		prefix = `${time} ${emoji}`;
	}

	// Discord thread name max is 100 chars
	let topic = opts.topic.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
	const maxTopicLen = 100 - prefix.length - 1;
	if (topic.length > maxTopicLen) {
		topic = `${topic.slice(0, maxTopicLen - 3).replace(/\s+\S*$/, "")}...`;
	}

	return `${prefix} ${topic}`;
}

function formatTime(): string {
	return new Date().toLocaleTimeString("en-US", {
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
	});
}

// ── Server-specific command helpers ──────────────────────────

/** Extract the Discord server config type from the config schema */
export type DiscordServerConfig = Extract<
	RandalConfig["gateway"]["channels"][number],
	{ type: "discord" }
>["servers"][number];

/** Extract the custom command config type */
export type DiscordCustomCommandConfig = DiscordServerConfig["commands"][number];

/** Option type string → discord.js ApplicationCommandOptionType value */
const OPTION_TYPE_MAP = {
	string: 3,
	integer: 4,
	boolean: 5,
	number: 10,
} as const;

/**
 * Build a SlashCommandBuilder from a custom command config definition.
 * Used for server-specific commands defined in randal.config.yaml.
 */
export function buildCustomCommand(cmd: DiscordCustomCommandConfig): SlashCommandBuilder {
	const builder = new SlashCommandBuilder()
		.setName(cmd.name)
		.setDescription(cmd.description);

	for (const opt of cmd.options) {
		switch (opt.type) {
			case "string":
				builder.addStringOption((o) => {
					o.setName(opt.name).setDescription(opt.description).setRequired(opt.required);
					if (opt.choices?.length) {
						o.addChoices(...opt.choices.map((c) => ({ name: c, value: c })));
					}
					return o;
				});
				break;
			case "integer":
				builder.addIntegerOption((o) => {
					o.setName(opt.name).setDescription(opt.description).setRequired(opt.required);
					if (opt.choices?.length) {
						o.addChoices(...opt.choices.map((c) => ({ name: c, value: Number.parseInt(c, 10) })));
					}
					return o;
				});
				break;
			case "boolean":
				builder.addBooleanOption((o) =>
					o.setName(opt.name).setDescription(opt.description).setRequired(opt.required),
				);
				break;
			case "number":
				builder.addNumberOption((o) => {
					o.setName(opt.name).setDescription(opt.description).setRequired(opt.required);
					if (opt.choices?.length) {
						o.addChoices(...opt.choices.map((c) => ({ name: c, value: Number.parseFloat(c) })));
					}
					return o;
				});
				break;
		}
	}

	return builder;
}

/**
 * Build the prompt string from a custom command invocation.
 * Combines the command name with option values into a natural prompt.
 */
export function buildCustomCommandPrompt(
	commandName: string,
	// biome-ignore lint: discord.js option types vary
	options: Array<{ name: string; value: any }>,
	instructions?: string,
): string {
	const parts: string[] = [];

	if (instructions) {
		parts.push(`## Instructions\n${instructions}`);
	}

	const optionParts = options.map((o) => `${o.name}: ${o.value}`).join(", ");
	const commandLine = optionParts ? `${commandName} — ${optionParts}` : commandName;
	parts.push(`## Command\n${commandLine}`);

	return parts.join("\n\n");
}
