import { createLogger } from "@randal/core";
import type { RandalConfig, RunnerEvent } from "@randal/core";
import { type ChannelAdapter, type ChannelDeps, formatEvent, handleCommand } from "./channel.js";

// Extract signal channel config type from the discriminated union
type SignalChannelConfig = Extract<RandalConfig["gateway"]["channels"][number], { type: "signal" }>;

// ── signal-cli JSON output types ────────────────────────────

interface SignalEnvelope {
	source?: string;
	sourceNumber?: string;
	sourceName?: string;
	dataMessage?: {
		timestamp: number;
		message?: string;
		attachments?: Array<{
			contentType: string;
			filename?: string;
			size: number;
		}>;
	};
}

interface SignalReceiveOutput {
	envelope?: SignalEnvelope;
}

/**
 * Normalize a phone number for comparison by stripping non-digit characters
 * (except leading +).
 */
function normalizePhone(phone: string): string {
	const trimmed = phone.trim();
	if (trimmed.startsWith("+")) {
		return `+${trimmed.slice(1).replace(/\D/g, "")}`;
	}
	return trimmed.replace(/\D/g, "");
}

export class SignalChannel implements ChannelAdapter {
	readonly name = "signal";
	private pollTimer?: ReturnType<typeof setTimeout>;
	private unsubscribe?: () => void;
	private reconnectDelay = 1000;
	private stopping = false;
	private polling = false;
	private logger = createLogger({ context: { component: "channel:signal" } });

	constructor(
		private channelConfig: SignalChannelConfig,
		private deps: ChannelDeps,
	) {}

	async start(): Promise<void> {
		this.stopping = false;

		// Verify signal-cli is available
		try {
			const proc = Bun.spawnSync([this.channelConfig.signalCliBin, "--version"], {
				timeout: 5000,
			});
			const version = proc.stdout.toString().trim();
			if (version) {
				this.logger.info("signal-cli found", { version });
			} else {
				this.logger.warn("signal-cli returned no version output");
			}
		} catch (err) {
			this.logger.warn("signal-cli not found or not accessible", {
				bin: this.channelConfig.signalCliBin,
				error: err instanceof Error ? err.message : String(err),
			});
		}

		// Start polling loop
		this.startPolling();

		// Subscribe to EventBus for outbound notifications
		this.unsubscribe = this.deps.eventBus.subscribe((event) => this.onRunnerEvent(event));

		this.logger.info("Signal channel started", {
			phoneNumber: this.channelConfig.phoneNumber,
		});
	}

	private startPolling(): void {
		if (this.stopping) return;
		this.pollOnce()
			.catch((err) => {
				this.logger.error("Signal poll failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			})
			.finally(() => {
				if (!this.stopping) {
					// Schedule next poll — use short interval on success, backoff on repeated errors
					this.pollTimer = setTimeout(() => this.startPolling(), this.reconnectDelay);
				}
			});
	}

	private async pollOnce(): Promise<void> {
		if (this.polling || this.stopping) return;
		this.polling = true;

		try {
			const proc = Bun.spawn(
				[
					this.channelConfig.signalCliBin,
					"-a",
					this.channelConfig.phoneNumber,
					"receive",
					"--json",
					"--timeout",
					"5",
				],
				{
					stdout: "pipe",
					stderr: "pipe",
				},
			);

			const output = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();
			await proc.exited;

			if (stderr.trim()) {
				this.logger.warn("signal-cli stderr", { stderr: stderr.trim().slice(0, 200) });
			}

			// Parse JSON lines output — each line is a separate JSON envelope
			if (output.trim()) {
				const lines = output.trim().split("\n");
				for (const line of lines) {
					try {
						const parsed = JSON.parse(line) as SignalReceiveOutput;
						await this.handleEnvelope(parsed);
					} catch {
						// Skip malformed lines
					}
				}
			}

			// Successful poll — reset backoff
			this.reconnectDelay = 1000;
		} catch (err) {
			this.logger.error("signal-cli receive failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			// Increase backoff on error, max 5 minutes
			this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5 * 60 * 1000);
		} finally {
			this.polling = false;
		}
	}

	private async handleEnvelope(output: SignalReceiveOutput): Promise<void> {
		const envelope = output.envelope;
		if (!envelope) return;

		const sender = envelope.source ?? envelope.sourceNumber;
		if (!sender) return;

		const dataMessage = envelope.dataMessage;
		if (!dataMessage) return;

		const text = dataMessage.message?.trim();
		if (!text) {
			// Check for attachments without text
			if (dataMessage.attachments && dataMessage.attachments.length > 0) {
				this.logger.info("Signal attachment received", {
					from: sender,
					attachments: dataMessage.attachments.length,
				});
			}
			return;
		}

		// allowFrom filter by phone number
		const allowFrom = this.channelConfig.allowFrom;
		if (allowFrom && allowFrom.length > 0) {
			const normalizedSender = normalizePhone(sender);
			const allowed = allowFrom.some((phone) => normalizePhone(phone) === normalizedSender);
			if (!allowed) return;
		}

		const origin = {
			channel: "signal" as const,
			replyTo: sender,
			from: normalizePhone(sender),
		};

		try {
			const response = await handleCommand(text, this.deps, origin);
			await this.sendMessage(sender, response);
		} catch (err) {
			this.logger.error("Signal message handling failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			try {
				await this.sendMessage(sender, "Something went wrong processing your request.");
			} catch {
				// Can't send
			}
		}
	}

	/**
	 * Send a message via signal-cli.
	 */
	private async sendMessage(recipient: string, text: string): Promise<void> {
		try {
			const proc = Bun.spawn(
				[
					this.channelConfig.signalCliBin,
					"-a",
					this.channelConfig.phoneNumber,
					"send",
					"-m",
					text,
					recipient,
				],
				{
					stdout: "pipe",
					stderr: "pipe",
				},
			);

			const stderr = await new Response(proc.stderr).text();
			const exitCode = await proc.exited;

			if (exitCode !== 0) {
				this.logger.warn("signal-cli send failed", {
					exitCode,
					stderr: stderr.trim().slice(0, 200),
					recipient,
				});
			}
		} catch (err) {
			this.logger.warn("Failed to send Signal message", {
				error: err instanceof Error ? err.message : String(err),
				recipient,
			});
		}
	}

	private onRunnerEvent(event: RunnerEvent): void {
		// Only send significant events
		const significant = ["job.complete", "job.failed", "job.stuck"];
		if (!significant.includes(event.type)) return;

		// Check origin
		const job = this.deps.runner.getJob(event.jobId);
		if (!job?.origin || job.origin.channel !== "signal") return;

		const message = formatEvent(event);
		this.sendMessage(job.origin.replyTo, message).catch((err) => {
			this.logger.warn("Failed to send Signal notification", {
				error: err instanceof Error ? err.message : String(err),
				jobId: event.jobId,
			});
		});
	}

	stop(): void {
		this.stopping = true;
		if (this.pollTimer) {
			clearTimeout(this.pollTimer);
			this.pollTimer = undefined;
		}
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = undefined;
		}
		this.logger.info("Signal channel stopped");
	}

	/**
	 * Send a Signal message to a phone number.
	 * Implements ChannelAdapter.send() for the internal channel API.
	 * Target should be a phone number (e.g., "+1234567890").
	 */
	async send(target: string, message: string): Promise<void> {
		await this.sendMessage(target, message);
	}
}
