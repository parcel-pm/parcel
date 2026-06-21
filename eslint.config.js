"use strict";

// Flat-config ESLint configuration for Parcel.
//
// Design constraints (see CONTRIBUTING.md §"Coding Standards" and
// CONSTITUTION.md §1.3.1 / §1.2.1):
//   - Source-dist parity: shipped JS under src/ is not transpiled or bundled,
//     so ESLint reads the files as-is. Stylistic rules are turned off via
//     eslint-config-prettier to avoid fighting `prettier --check`.
//   - No third-party runtime dependencies; ESLint is dev-only and never
//     shipped.
//
// Wiring: `make lint` runs `eslint .`; `make test-syntax` invokes `make lint`
// so the gate sits next to the existing `prettier --check` step.
//
// Note on the `strict` rule: CONTRIBUTING.md §"Coding Standards" mandates a
// `"use strict";` directive at the top of every JS file. Every file in src/
// and test/ follows this convention. ESLint's `strict` rule would flag those
// (correct but redundant) directives as errors in ES modules, directly
// conflicting with the documented mandate, so the rule is disabled. The
// "use strict" convention itself is enforced via CONTRIBUTING review and
// is preserved rather than auto-removed.

import globals from "globals";
import js from "@eslint/js";
import prettier from "eslint-config-prettier";

export default [
    {
        ignores: [
            // Generated / synced output directories — never lint the build.
            "chrome/",
            "firefox/",
            "dist/",
            "src/dist/",
            "src/publicsuffix/",
            // Sources pulled in via npm.
            "node_modules/",
        ],
    },
    js.configs.recommended,
    {
        files: ["**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
            globals: {
                ...globals.browser,
                ...globals.node,
            },
        },
        rules: {
            // CONTRIBIBURING.md mandates `"use strict";` at the top of every
            // file; the directive is technically redundant in ES modules but
            // kept for documentation. Disable ESLint's `strict` rule, which
            // would otherwise flag and try to auto-remove the directive.
            strict: "off",
            // Catch the equality / coercion class of bugs that Prettier
            // cannot see (e.g. `popup.js` had `action == "origin"` at the
            // time of audit).
            eqeqeq: ["error", "always", { null: "ignore" }],
            // Enforce modern variable declarations.
            "no-var": "error",
            "prefer-const": [
                "error",
                {
                    destructuring: "any",
                    ignoreReadBeforeAssign: true,
                },
            ],
            // Surface unused arguments and silent catches.
            "no-unused-vars": [
                "error",
                {
                    args: "after-used",
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrorsIgnorePattern: "^_",
                },
            ],
            "no-unreachable": "error",
            "no-debugger": "error",
        },
    },
    {
        // Browser-extension context: the global `chrome` namespace is
        // provided by Chrome's MV3 runtime and is not in the `globals`
        // package under that name. Firefox content scripts expose a
        // top-level `browser` global instead.
        files: ["src/**/*.js", "test/**/*.js"],
        languageOptions: {
            globals: {
                chrome: "readonly",
                browser: "readonly",
            },
        },
    },
    {
        // Test suite: runs under Node's `node:test` runner and mocks
        // chrome APIs heavily. Allow unused rest-siblings (common when
        // destructuring mock shapes) and let _-prefixed names signal intent.
        files: ["test/**/*.js"],
        rules: {
            "no-unused-vars": [
                "error",
                {
                    args: "after-used",
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrorsIgnorePattern: "^_",
                    ignoreRestSiblings: true,
                },
            ],
        },
    },
    prettier,
];
