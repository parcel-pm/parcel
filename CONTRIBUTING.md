# Contributing to Parcel

Thank you for your interest in contributing to Parcel. This document outlines the process and standards expected for all contributions.

## Getting Started

Please ensure that you are familiar with the [project constitution][1]. In order to improve security, this project imposes a number of restrictions on contributions that are not typical for most other open-source projects.

### Prerequisites

- **Node.js** (for running tests)
  - **Prettier** (`npm install` or use your package manager)
  - **JSDom** (`npm install` or use your package manager)
- **jq** >= 1.5
- **gpg** >= 2.2.20
- A valid GPG key for signing commits

### Building

Parcel uses `make` for all build tasks. By default, running `make` on its own will build everything, but will not run tests.

```bash
# Build the shared extension bundle (runs Prettier + copies assets to src/dist/)
make extension

# Build the Chrome extension
make chrome

# Build the Firefox extension
make firefox

# Build everything
make all

# Clean generated artifacts
make clean
```

### Formatting

All source code must be formatted with Prettier before committing:

```bash
make prettier
```

### Linting

In addition to formatting, ESLint runs a semantic check that catches issues Prettier cannot (loose equality, missing `"use strict"`, `var` instead of `let`/`const`, unreachable code, unused variables, unsafe optional chaining). ESLint is a dev-only dependency and is run automatically as part of `make test-syntax` (and therefore `make test`):

```bash
# lint only
make lint

# lint + prettier check (run by CI)
make test-syntax
```

The flat config lives at `eslint.config.js` in the repository root. Stylistic rules are turned off there via `eslint-config-prettier` so ESLint never fights Prettier; only semantic rules are enforced.

## Coding Standards

### Browser Extension

- All JavaScript files **must** begin with `"use strict";`.
- Use native browser APIs only. **No third-party runtime dependencies** are permitted (see [constitution][1] §1.3.1).
- Source code in `src/` is distributed as-is. **No transpilation, bundling, or minification** (Webpack, TypeScript, Babel, etc.) is permitted.
- Use ES modules (`import`/`export`) for code organisation.
- Follow the existing JSDoc conventions for public APIs.
- Keep the public API surface of each module explicit and documented.

### Native Host

- Quote all variables to prevent word splitting and glob expansion.
- Prefer `jq` for JSON manipulation over ad-hoc text processing.
- Verify compatibility with both GNU and BSD / macOS tool variants where possible, as tools with the same name can have differing functionality or interfaces between these platforms.
- Do not introduce the use of any additional shell tools unless they are both legitimately necessary, and available out-of-the-box on both MacOS and most Linux distributions.

## Testing

In addition to the automated test suite, please ensure that your changes are thoroughly human-tested in both Chrome and Firefox. Contributions that do not pass the full test suite will not be accepted.

The following automated tests are available using Node.js's built-in `node:test` runner:

```bash
# run all available tests
make test

# run the native host tests only
make test-native

# run the chrome mockup tests only
make test-browser-mock

# run the extension module tests only
make test-modules

# run the application-level tests only
make test-application

# run syntax tests only
make test-syntax
```

### Docker

If you would prefer to test your changes in an isolated container instead of installing the test requirements on your system, you can use the provided `Dockerfile` to build an image with all necessary test dependencies pre-installed.

```bash
# Build the Docker image
DOCKER_BUILDKIT=1 docker build -t parcel-test .

# Run the full test suite in the container
docker run --rm -v "$PWD":/parcel -it parcel-test test
```

## Submitting Changes

1. **Fork and branch** from the latest `master`.
2. **Make your changes** in the `src/` tree. Do not edit generated output under `src/dist/`, `chrome/`, or `firefox/`.
3. **Format the code** with `make prettier`.
4. **Test thoroughly** (see Testing above).
5. **Add any additional tests needed** to ensure coverage of your changes.
5. **Sign your commits** with a valid GPG key.
6. **Open a Pull Request** with a clear description of the change and the motivation behind it.

All contributions must be reviewed and approved by at least one project maintainer before merge. Final approval must be performed by a human, not an automated system.

You must ensure that your contribution does not infringe on any third-party intellectual property rights. By opening a PR, you certify that you have full authority to make the contribution under the ISC licence.

## Security

Parcel is a security-critical project. When contributing, please keep the following in mind:

- Minimise the attack surface of any new feature.
- Do not introduce network access of any kind.
- Do not add file-write capabilities outside the host's own config and log files.
- Do not introduce third-party dependencies that violate [constitution][1] §1.3.1.
- Do not expose plaintext anywhere it does not absolutely need to be.

## Release Process

Releases are managed by the core maintainers only. Do not bump version numbers or generate release artifacts in your PR.

## Questions?

If you are unsure about any of the above, please open an issue for discussion before investing significant time in implementation.

[1]: CONSTITUTION.md
