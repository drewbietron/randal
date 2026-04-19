import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { voiceCommand } from "./voice.js";

const originalLog = console.log;
const originalError = console.error;

let logs: string[];
let errors: string[];

beforeEach(() => {
	logs = [];
	errors = [];
	console.log = mock((...args: unknown[]) => {
		logs.push(args.map(String).join(" "));
	});
	console.error = mock((...args: unknown[]) => {
		errors.push(args.map(String).join(" "));
	});
});

afterEach(() => {
	console.log = originalLog;
	console.error = originalError;
});

describe("voice command", () => {
	test("call --help prints usage without treating help as a phone number", async () => {
		await voiceCommand(["call", "--help"], { config: null, url: "http://localhost:7600" });

		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("randal voice call <to>");
		expect(logs).toHaveLength(0);
	});
});
