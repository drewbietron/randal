import { readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { CliContext } from "../cli.js";

const PID_FILE = resolve(process.env.HOME ?? ".", ".randal/gateway.pid");

export function readPid(): number | null {
	try {
		const pid = Number.parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
		if (Number.isNaN(pid)) return null;
		// Check if process is alive
		try {
			process.kill(pid, 0);
			return pid;
		} catch {
			// Stale PID file
			try {
				unlinkSync(PID_FILE);
			} catch {
				/* ignore */
			}
			return null;
		}
	} catch {
		return null;
	}
}

function killGateway(signal: NodeJS.Signals = "SIGTERM"): boolean {
	const pid = readPid();
	if (!pid) {
		console.log("No running gateway found.");
		return false;
	}
	try {
		process.kill(pid, signal);
		console.log(`Sent ${signal} to gateway (PID ${pid}).`);
		return true;
	} catch (err) {
		console.error(
			`Failed to kill gateway (PID ${pid}): ${err instanceof Error ? err.message : err}`,
		);
		return false;
	}
}

async function waitForExit(pid: number, timeoutMs = 5000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			process.kill(pid, 0);
			await Bun.sleep(200);
		} catch {
			return true; // Process exited
		}
	}
	return false;
}

export async function gatewayCommand(args: string[], ctx: CliContext): Promise<void> {
	const sub = args[0];

	switch (sub) {
		case "status": {
			const pid = readPid();
			if (pid) {
				console.log(`Gateway is running (PID ${pid}).`);
			} else {
				// Also try health check
				const url = ctx.url ?? "http://localhost:7600";
				try {
					const res = await fetch(`${url}/health`);
					if (res.ok) {
						console.log(
							`Gateway is running at ${url} (no PID file — started before PID tracking was added).`,
						);
					} else {
						console.log("Gateway is not running.");
					}
				} catch {
					console.log("Gateway is not running.");
				}
			}
			break;
		}

		case "kill": {
			const force = args.includes("--force") || args.includes("-f");
			const pid = readPid();

			if (!pid) {
				// Fallback: try to find by port
				console.log("No PID file found. Trying to find gateway process...");
				const result = Bun.spawnSync(["lsof", "-ti", ":7600"]);
				const pids = result.stdout.toString().trim().split("\n").filter(Boolean);
				if (pids.length > 0) {
					for (const p of pids) {
						try {
							process.kill(Number.parseInt(p, 10), force ? "SIGKILL" : "SIGTERM");
							console.log(`Killed process ${p} on port 7600.`);
						} catch {
							/* ignore */
						}
					}
				} else {
					console.log("No gateway process found.");
				}
				break;
			}

			if (force) {
				killGateway("SIGKILL");
			} else {
				killGateway("SIGTERM");
				const exited = await waitForExit(pid);
				if (!exited) {
					console.log("Gateway did not exit gracefully, sending SIGKILL...");
					killGateway("SIGKILL");
				}
			}
			// Clean up PID file
			try {
				unlinkSync(PID_FILE);
			} catch {
				/* ignore */
			}
			break;
		}

		case "restart": {
			const pid = readPid();
			if (pid) {
				console.log("Stopping gateway...");
				killGateway("SIGTERM");
				const exited = await waitForExit(pid);
				if (!exited) {
					console.log("Force killing...");
					killGateway("SIGKILL");
					await waitForExit(pid, 2000);
				}
				try {
					unlinkSync(PID_FILE);
				} catch {
					/* ignore */
				}
			}
			console.log("Starting gateway...");
			const { serveCommand } = await import("./serve.js");
			await serveCommand(args.slice(1), ctx);
			break;
		}

		case "reload": {
			const pid = readPid();
			if (!pid) {
				console.error("No running gateway found. Use 'randal serve' to start one.");
				process.exit(1);
			}
			console.log(`Sending SIGHUP to gateway (PID ${pid}) for graceful reload...`);
			try {
				process.kill(pid, "SIGHUP");
				console.log(
					"Reload signal sent. The gateway will restart in-place and resume any interrupted jobs.",
				);
			} catch (err) {
				console.error(`Failed to send SIGHUP: ${err instanceof Error ? err.message : err}`);
				process.exit(1);
			}
			break;
		}

		case "token": {
			const token = process.env.RANDAL_API_TOKEN;
			if (token) {
				console.log(token);
			} else {
				console.log("RANDAL_API_TOKEN is not set in environment.");
				console.log("Check your .env file for the RANDAL_API_TOKEN value.");
			}
			break;
		}

		default:
			console.log(`
  Usage: randal gateway <command>

  Commands:
    status          Check if gateway is running
    kill [--force]  Kill the running gateway
    restart         Kill and restart the gateway
    reload          Graceful reload (SIGHUP) — restarts in-place, resumes jobs
    token           Show the dashboard API token
`);
			break;
	}
}
