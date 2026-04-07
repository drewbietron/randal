import { describe, expect, test } from "bun:test";
import { checkStruggle } from "./struggle-check.js";

describe("checkStruggle", () => {
	test("returns ok when no issues", () => {
		const result = checkStruggle({
			iterations_without_progress: 0,
			recent_errors: 0,
		});
		expect(result.isStuck).toBe(false);
		expect(result.severity).toBe("ok");
		expect(result.indicators).toHaveLength(0);
	});

	test("returns warning on 3 iterations without progress", () => {
		const result = checkStruggle({
			iterations_without_progress: 3,
			recent_errors: 0,
		});
		expect(result.isStuck).toBe(true);
		expect(result.severity).toBe("warning");
		expect(result.indicators).toHaveLength(1);
	});

	test("returns critical on 5 iterations without progress", () => {
		const result = checkStruggle({
			iterations_without_progress: 5,
			recent_errors: 0,
		});
		expect(result.severity).toBe("critical");
	});

	test("returns warning on 3 consecutive errors", () => {
		const result = checkStruggle({
			iterations_without_progress: 0,
			recent_errors: 3,
		});
		expect(result.isStuck).toBe(true);
		expect(result.severity).toBe("warning");
	});

	test("returns critical on 5 consecutive errors", () => {
		const result = checkStruggle({
			iterations_without_progress: 0,
			recent_errors: 5,
		});
		expect(result.severity).toBe("critical");
	});

	test("returns critical on identical outputs", () => {
		const result = checkStruggle({
			iterations_without_progress: 0,
			recent_errors: 0,
			identical_output_count: 3,
		});
		expect(result.isStuck).toBe(true);
		expect(result.severity).toBe("critical");
	});

	test("detects high token burn with stall", () => {
		const result = checkStruggle({
			iterations_without_progress: 2,
			recent_errors: 0,
			token_burn_ratio: 2.0,
		});
		expect(result.isStuck).toBe(true);
		expect(result.indicators.some((i) => i.includes("token"))).toBe(true);
	});

	test("does not flag token burn without stall", () => {
		const result = checkStruggle({
			iterations_without_progress: 1,
			recent_errors: 0,
			token_burn_ratio: 2.0,
		});
		// iterations_without_progress < 2, so token burn alone doesn't trigger
		expect(result.isStuck).toBe(false);
		expect(result.severity).toBe("ok");
	});

	test("multiple indicators combine correctly", () => {
		const result = checkStruggle({
			iterations_without_progress: 5,
			recent_errors: 5,
			identical_output_count: 4,
		});
		expect(result.severity).toBe("critical");
		expect(result.indicators.length).toBeGreaterThanOrEqual(3);
	});

	test("recommendation matches severity", () => {
		const ok = checkStruggle({ iterations_without_progress: 0, recent_errors: 0 });
		expect(ok.recommendation).toContain("Continue");

		const warn = checkStruggle({ iterations_without_progress: 3, recent_errors: 0 });
		expect(warn.recommendation).toContain("changing approach");

		const crit = checkStruggle({ iterations_without_progress: 5, recent_errors: 5 });
		expect(crit.recommendation).toContain("STOP");
	});

	test("defaults optional fields when omitted", () => {
		const result = checkStruggle({
			iterations_without_progress: 0,
			recent_errors: 0,
			// identical_output_count and token_burn_ratio omitted
		});
		expect(result.isStuck).toBe(false);
		expect(result.severity).toBe("ok");
	});
});
