import { defineConfig } from "vitest/config";

// Node environment, no jsdom: nothing in the engine touches a browser API.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
