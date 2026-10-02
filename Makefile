.PHONY: fmt lint test test-node test-bun test-pi build-release

fmt:
	cargo fmt --all
	npx oxfmt packages

lint:
	cargo fmt --all --check
	npx oxfmt --check packages
	CARGO_BUILD_WARNINGS=deny cargo clippy --workspace --all-targets --all-features --locked
	RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps --locked
	npm run build
	npm run typecheck

test:
	cargo test --workspace --all-features --locked
	cargo build -p persistent-exec-ffi --locked
	npm test

test-node:
	npm test --workspace persistent-exec-node

test-bun:
	bun test packages/persistent-exec-bun/test

test-pi:
	bun test packages/pi-unified-exec/test

build-release:
	cargo build --release -p persistent-exec-ffi --locked
	npm run build
