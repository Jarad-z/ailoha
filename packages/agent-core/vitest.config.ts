import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		reporters: "verbose",
		testTimeout: 10_000,
	},
});
