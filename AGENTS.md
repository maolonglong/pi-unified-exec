# Project guidance

## Runtime invariants

- Keep `persistent-exec-core` transport-neutral. Put C ABI concerns in `persistent-exec-ffi`, runtime-specific loading in the Node/Bun packages, and pi lifecycle/tool behavior in `@chensl/pi-unified-exec`.
- Preserve the versioned C ABI and opaque runtime handle. Do not expose Rust layouts across FFI.
- Keep one native runtime per pi session and terminate it on session replacement, extension reload, and shutdown.
- Keep native output and session counts bounded. Partial output must be bounded as well as final output, and truncation metadata must include bytes omitted by the Rust runtime.
- Unix cleanup owns process groups; Windows cleanup owns Job Objects. Do not claim that Unix processes which deliberately create a new session remain contained.

## Pi tool contracts

- Keep each pi tool's `promptSnippet` to a one-line capability summary. Put the observable call/result contract in `description` and parameter descriptions.
- Keep `exec_command` and `write_stdin` function descriptions and supported-parameter schemas verbatim-aligned with Codex; do not expose Codex parameters whose behavior this project does not implement.
- Keep the model-facing result text in the Codex format (`Wall time`, process status, `Original token count`, `Output`). Expose structured data through `outputSchema` and `structuredContent`, and set `isError` for failed or cancelled commands.
- Add `promptGuidelines` only for non-obvious behavior that the schema and descriptions cannot express. Do not instruct the model about tools removed from the active set.

## Cross-platform process behavior

- Support Linux, macOS, and Windows for process lifecycle changes. Keep pipe and PTY behavior aligned unless an OS API requires a documented difference.
- After Windows-specific Rust changes, run:
  `cargo check --workspace --all-targets --target x86_64-pc-windows-msvc`
  and the equivalent targeted Clippy command.
- Preserve the upstream license headers in the copied ConPTY sources under `crates/persistent-exec-pty/src/win/`.

## Verification

- Match checks to the change: documentation-only edits need no build or test suite; localized code changes need affected formatting, lint/type checks, and tests. Use `make fmt`, `make lint`, and `make test` for shared runtime, FFI, or cross-package changes.
- Before Node/Bun runtime tests (`make test-node`, `make test-bun`, `make test-pi`), run `cargo build -p persistent-exec-ffi --locked`; the SDKs load the local native library.
- Run local npm commands with `NPM_CONFIG_REGISTRY=https://registry.npmjs.org/` so lockfile `resolved` URLs stay on the public registry; `scripts/check-lockfile-registry.mjs` enforces it in `make lint` and CI.
- Run Linux PTY tests in a container with an init process (`docker run --init`); without one, PID 1 never reaps zombies and the process-group tests fail spuriously.
- `scripts/*.test.mjs` copy every directory under `packages/`; remove stale untracked package directories before running `npm test` locally.
- Local verification and fixing failures caused by the requested change do not need intermediate approval. Finish the affected checks rather than stopping at the first implementation; report blockers and unrelated failures.
- For packaging or release changes, also run `make build-release`, inspect `npm pack` contents, and verify an isolated tarball install. Native packages must contain the dynamic library, `LICENSE`, and `NOTICE`.

## Commits

- Use atomic Conventional Commits: `<type>(<scope>): <summary>`, a blank line, and a required body explaining why, observable impact, relevant trade-offs, and verification. Use imperative, lowercase English summaries without a trailing period, preferably under 72 characters.
- Types: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`, `revert`. Optional ownership scopes: `core`, `ffi`, `pty`, `node`, `bun`, `pi`, `release`, `deps`, `docs`, `ci`, `repo`.
- Put metadata in trailers after a blank line (`Fixes: #123`, `Refs: #123`). Breaking changes require both `!` in the header and a `BREAKING CHANGE:` trailer with migration guidance.

## Packaging

- Keep platform package names synchronized across Node/Bun `optionalDependencies`, both `binary.ts` lookup maps, `scripts/stage-native.mjs`, and the release workflow matrix.
- Publish npm packages in dependency order: platform binary packages first, Node/Bun wrappers second, and `@chensl/pi-unified-exec` last.
- Keep package versions synchronized while wrappers use exact versions for native and runtime dependencies.

## Changelog and releases

- `packages/pi-unified-exec/CHANGELOG.md` is the source of truth for user-facing release notes. Keep one top-level `## [Unreleased]` section and add user-visible changes only; order categories as Breaking Changes, Added, Changed, Fixed, and Removed.
- Treat released changelog sections as immutable. Use `managing-changelog` to audit the final changes since the prior stable `vX.Y.Z` tag; review requests are read-only unless editing is requested.
- Use `releasing` for release preparation, publication, and recovery. During 0.x development, use patch for compatible additions/fixes and minor for breaking changes; document the migration path.
- Release only from a clean local `main` containing the latest `origin/main`. `scripts/release.mjs` owns version synchronization, verification, release commits/tags, and the next `[Unreleased]` section; do not perform these release steps manually.
- `npm run release:patch` and `npm run release:minor` push main and a `v*` tag, triggering real npm publication. Obtain explicit release authorization before invoking either command without `-- --check`; preparation and verification alone do not authorize publication. GitHub Releases become public only after npm publication succeeds.
- Recover partial publication using the original tag and original artifacts. Existing tarballs must match published integrity before being skipped; never rebuild an already-partially-published version.
- There is no unrelease path. Do not delete a public GitHub Release, retag, unpublish npm versions, or move dist-tags as routine recovery. Publish a corrective version instead.
