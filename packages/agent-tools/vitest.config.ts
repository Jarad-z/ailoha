import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@ailoha/agent-core": fileURLToPath(new URL("../agent-core/src/index.ts", import.meta.url)),
		},
	},
	test: {
		environment: "node",
		reporters: "verbose",
		testTimeout: 10_000,
	},
});
