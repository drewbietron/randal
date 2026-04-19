import { describe, expect, test } from "bun:test";
import {
	DEFAULT_LOCAL_MEILI_URL,
	getLocalMeilisearchDockerPortBinding,
	getLocalMeilisearchTarget,
} from "./serve.js";

describe("serve Meilisearch bootstrap helpers", () => {
	test("uses the canonical local default URL", () => {
		expect(DEFAULT_LOCAL_MEILI_URL).toBe("http://localhost:7701");
		expect(getLocalMeilisearchDockerPortBinding(DEFAULT_LOCAL_MEILI_URL)).toBe("7701:7700");
	});

	test("preserves an explicit local override port", () => {
		const target = getLocalMeilisearchTarget("http://127.0.0.1:7700");
		expect(target?.host).toBe("127.0.0.1:7700");
		expect(getLocalMeilisearchDockerPortBinding("http://127.0.0.1:7700")).toBe("7700:7700");
	});

	test("treats explicit hosted URLs as non-local", () => {
		expect(getLocalMeilisearchTarget("https://meili.railway.internal:7700")).toBeNull();
		expect(getLocalMeilisearchDockerPortBinding("https://meili.railway.internal:7700")).toBeNull();
	});
});
