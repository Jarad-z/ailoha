import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
	resolve: {
		alias: {
			"@ailoha/agent-core": fileURLToPath(new URL("../agent-core/src/index.ts", import.meta.url)),
		},
	},
	test: { environment: "node" },
});
