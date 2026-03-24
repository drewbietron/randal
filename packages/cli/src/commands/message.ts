import type { CliContext } from "../cli.js";

export async function messageCommand(args: string[], ctx: CliContext): Promise<void> {
	const url = ctx.url ?? "http://localhost:7600";
	const authToken = process.env.RANDAL_API_TOKEN ?? "";
	const sub = args[0];

	const headers: Record<string, string> = {};
	if (authToken) headers.Authorization = `Bearer ${authToken}`;

	if (!sub || sub === "--help") {
		console.log(`
Usage:
  randal message add <content> [--thread <id>] [--speaker <user|randal>] [--channel <name>] [--pending <action>]
  randal message search <query> [--limit <n>]
  randal message list [--limit <n>]
  randal message thread <thread-id> [--limit <n>]
  randal message pending [--limit <n>]
  randal message resolve <message-id>
`);
		return;
	}

	if (sub === "add") {
		// Collect flags first so we can exclude them from content
		let thread: string | undefined;
		let speaker = "user";
		let channel = "cli";
		let pending: string | undefined;

		const contentParts: string[] = [];
		for (let i = 1; i < args.length; i++) {
			if (args[i] === "--thread") {
				thread = args[++i];
			} else if (args[i] === "--speaker") {
				speaker = args[++i];
			} else if (args[i] === "--channel") {
				channel = args[++i];
			} else if (args[i] === "--pending") {
				pending = args[++i];
			} else {
				contentParts.push(args[i]);
			}
		}

		const content = contentParts.join(" ");
		if (!content) {
			console.error("Usage: randal message add <content>");
			process.exit(1);
		}

		try {
			const body: Record<string, string> = {
				content,
				speaker,
				channel,
				threadId: thread ?? `cli-${Date.now()}`,
			};
			if (pending) body.pendingAction = pending;

			const res = await fetch(`${url}/messages`, {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const result = (await res.json()) as { id?: string; error?: string };
			if (result.id) {
				console.log(`Saved message ${result.id}`);
			} else {
				console.error(`Failed: ${result.error ?? "unknown error"}`);
				process.exit(1);
			}
		} catch (err) {
			console.error(`Failed: ${err instanceof Error ? err.message : err}`);
			process.exit(1);
		}
	} else if (sub === "search") {
		const query = args[1];
		if (!query) {
			console.error("Usage: randal message search <query>");
			process.exit(1);
		}

		let limit: number | undefined;
		for (let i = 2; i < args.length; i++) {
			if (args[i] === "--limit") limit = Number.parseInt(args[++i], 10);
		}

		const params = new URLSearchParams({ q: query });
		if (limit) params.set("limit", String(limit));

		try {
			const res = await fetch(`${url}/messages/search?${params}`, { headers });
			const docs = (await res.json()) as Array<{
				speaker: string;
				channel: string;
				content: string;
				timestamp: string;
				threadId: string;
			}>;
			for (const doc of docs) {
				const ts = new Date(doc.timestamp).toLocaleString();
				console.log(`[${ts}] ${doc.speaker} (${doc.channel}/${doc.threadId}): ${doc.content}`);
			}
			if (docs.length === 0) console.log("No messages found");
		} catch (err) {
			console.error(`Failed: ${err instanceof Error ? err.message : err}`);
			process.exit(1);
		}
	} else if (sub === "list") {
		let limit: number | undefined;
		for (let i = 1; i < args.length; i++) {
			if (args[i] === "--limit") limit = Number.parseInt(args[++i], 10);
		}

		const params = new URLSearchParams();
		if (limit) params.set("limit", String(limit));

		try {
			const res = await fetch(`${url}/messages/recent?${params}`, { headers });
			const docs = (await res.json()) as Array<{
				speaker: string;
				channel: string;
				content: string;
				timestamp: string;
				threadId: string;
			}>;
			for (const doc of docs) {
				const ts = new Date(doc.timestamp).toLocaleString();
				console.log(`[${ts}] ${doc.speaker} (${doc.channel}/${doc.threadId}): ${doc.content}`);
			}
			if (docs.length === 0) console.log("No messages found");
		} catch (err) {
			console.error(`Failed: ${err instanceof Error ? err.message : err}`);
			process.exit(1);
		}
	} else if (sub === "thread") {
		const threadId = args[1];
		if (!threadId) {
			console.error("Usage: randal message thread <thread-id>");
			process.exit(1);
		}

		let limit: number | undefined;
		for (let i = 2; i < args.length; i++) {
			if (args[i] === "--limit") limit = Number.parseInt(args[++i], 10);
		}

		const params = new URLSearchParams();
		if (limit) params.set("limit", String(limit));

		try {
			const res = await fetch(`${url}/messages/thread/${encodeURIComponent(threadId)}?${params}`, {
				headers,
			});
			const docs = (await res.json()) as Array<{
				speaker: string;
				channel: string;
				content: string;
				timestamp: string;
				pendingAction?: string;
			}>;
			for (const doc of docs) {
				const ts = new Date(doc.timestamp).toLocaleString();
				const pendingTag = doc.pendingAction ? ` [PENDING: ${doc.pendingAction}]` : "";
				console.log(`[${ts}] ${doc.speaker}: ${doc.content}${pendingTag}`);
			}
			if (docs.length === 0) console.log("No messages in thread");
		} catch (err) {
			console.error(`Failed: ${err instanceof Error ? err.message : err}`);
			process.exit(1);
		}
	} else if (sub === "pending") {
		let limit: number | undefined;
		for (let i = 1; i < args.length; i++) {
			if (args[i] === "--limit") limit = Number.parseInt(args[++i], 10);
		}

		const params = new URLSearchParams();
		if (limit) params.set("limit", String(limit));

		try {
			const res = await fetch(`${url}/messages/pending?${params}`, { headers });
			const docs = (await res.json()) as Array<{
				id: string;
				speaker: string;
				content: string;
				timestamp: string;
				pendingAction: string;
				threadId: string;
			}>;
			for (const doc of docs) {
				const ts = new Date(doc.timestamp).toLocaleString();
				console.log(`[${ts}] ${doc.speaker} (${doc.threadId}): ${doc.content}`);
				console.log(`  → Pending: ${doc.pendingAction} (id: ${doc.id})`);
			}
			if (docs.length === 0) console.log("No pending actions");
		} catch (err) {
			console.error(`Failed: ${err instanceof Error ? err.message : err}`);
			process.exit(1);
		}
	} else if (sub === "resolve") {
		const messageId = args[1];
		if (!messageId) {
			console.error("Usage: randal message resolve <message-id>");
			process.exit(1);
		}

		try {
			const res = await fetch(`${url}/messages/${encodeURIComponent(messageId)}/resolve`, {
				method: "POST",
				headers,
			});
			const result = (await res.json()) as { ok?: boolean; error?: string };
			if (result.ok) {
				console.log(`Resolved pending action on message ${messageId}`);
			} else {
				console.error(`Failed: ${result.error ?? "unknown error"}`);
				process.exit(1);
			}
		} catch (err) {
			console.error(`Failed: ${err instanceof Error ? err.message : err}`);
			process.exit(1);
		}
	} else {
		console.error(`Unknown message subcommand: ${sub}`);
		process.exit(1);
	}
}
