import { defineConfig } from "vitest/config";

// Pure-logic unit tests (no DOM needed) run under node. The trigger-template
// golden-corpus check (src/lib/triggerTemplates.test.ts) is a standalone
// assert-script bundled with esbuild and run under node (see its header), not
// a vitest suite, so it is excluded here.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", "src/lib/triggerTemplates.test.ts"],
    environment: "node",
  },
});
