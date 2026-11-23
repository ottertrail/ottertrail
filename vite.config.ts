import { defineConfig } from "vite-plus";

export default defineConfig({
  defaultPackage: {
    dev: "./apps/web",
    build: "./apps/web",
    preview: "./apps/web",
    pack: "./apps/api",
  },
  fmt: {
    ignorePatterns: ["**/dist/**", "pnpm-lock.yaml"],
    sortImports: true,
    sortTailwindcss: {
      stylesheet: "./apps/web/src/styles/globals.css",
      functions: ["cn", "cva"],
    },
  },
  lint: {
    plugins: ["typescript", "unicorn", "oxc", "import"],
    categories: {
      correctness: "error",
      suspicious: "warn",
    },
    ignorePatterns: ["**/dist/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "import/no-cycle": "error",
      "import/no-unassigned-import": ["warn", { allow: ["**/*.css"] }],
      "typescript/no-floating-promises": "error",
      "typescript/no-misused-promises": "error",
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
    overrides: [
      {
        files: ["apps/web/**/*.ts", "apps/web/**/*.tsx"],
        plugins: ["react", "jsx-a11y"],
        env: { browser: true },
        rules: {
          "react/react-in-jsx-scope": "off",
          "react/rules-of-hooks": "error",
          "react/exhaustive-deps": "warn",
          "react/only-export-components": ["warn", { allowConstantExport: true }],
        },
      },
      {
        // Allow upstream shadcn/ui patterns to keep updates reviewable.
        files: ["apps/web/src/components/ui/*.tsx"],
        plugins: ["react", "jsx-a11y"],
        rules: {
          "react/only-export-components": "off",
          "jsx-a11y/label-has-associated-control": "off",
          "jsx-a11y/prefer-tag-over-role": "off",
          "typescript/no-unsafe-type-assertion": "off",
          "eslint/no-shadow": "off",
        },
      },
      {
        files: ["packages/tracker/**/*.ts"],
        env: { browser: true },
      },
      {
        files: ["apps/api/**/*.ts", "scripts/**/*.ts"],
        plugins: ["node"],
        env: { node: true },
        rules: {
          // Fastify awaits async handlers and sends their errors.
          "oxc/no-async-endpoint-handlers": "off",
        },
      },
      {
        // These tools cast JSON replies from external software.
        files: ["tools/**/*.ts"],
        plugins: ["node"],
        env: { node: true },
        rules: {
          "typescript/no-unsafe-type-assertion": "off",
        },
      },
      {
        files: ["**/*.test.ts", "**/*.test.tsx"],
        plugins: ["vitest"],
        rules: {
          // Tests cast parsed JSON and fakes to the shape under test.
          "typescript/no-unsafe-type-assertion": "off",
        },
      },
    ],
  },
  run: {
    // Migrations change the database, and tests need its current state.
    cache: { scripts: false, tasks: true },
  },
  // Runs from .vite-hooks/pre-commit on the files being committed.
  staged: {
    "*": "vp check --fix",
  },
});
