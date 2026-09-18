# claude-view task runner — https://github.com/casey/just
#
# `cargo test` / `cargo clippy` / `cargo check` all live under src-tauri/,
# whose tauri.conf.json points frontendDist at ../dist. dist/ is gitignored,
# so on a clean checkout it doesn't exist until the frontend has been built.
# `build` is therefore a prerequisite for every cargo-touching recipe; `ci`
# is the one recipe that wires that up end to end, and is what CI invokes.

# List available recipes.
default:
    @just --list

# Build the frontend bundle (required before any cargo command — see above).
build:
    npm ci
    npm run build

# Type-check the frontend and format/lint-check the Rust backend.
lint: _lint-frontend _lint-rust

_lint-frontend:
    # `npx`, not a bare `tsc`: just's recipe shell doesn't get the
    # node_modules/.bin PATH prepending that `npm run` gives you for free.
    npx tsc --noEmit

[working-directory: 'src-tauri']
_lint-rust:
    cargo fmt --check
    cargo clippy --all-targets --locked -- -D warnings

# Run the Rust test suite.
[working-directory: 'src-tauri']
test:
    cargo test --locked

# Fix Rust formatting (the counterpart to `lint`'s check).
[working-directory: 'src-tauri']
fmt:
    cargo fmt

# Full pipeline: build, then lint, then test. The single recipe CI invokes.
ci: build lint test

# Run the app in dev mode.
dev:
    npm run tauri dev

# Build the downloadable Linux artifacts (.deb + .AppImage).
#
# APPIMAGE_EXTRACT_AND_RUN=1 is needed on Arch: linuxdeploy is itself an AppImage
# and mounts via FUSE *2*, but Arch ships only fusermount3.
#
# NOTE: on modern Arch the AppImage still fails, for an unrelated reason --
# gdk-pixbuf 2.44+ ships no /usr/lib/gdk-pixbuf-2.0/2.10.0 while pkg-config still
# advertises it, and linuxdeploy-plugin-gtk copies that path unconditionally.
# See packaging/README.md. The deb builds fine either way.
package:
    APPIMAGE_EXTRACT_AND_RUN=1 npm run tauri build -- --bundles deb,appimage

# Repackage the release binary as an Arch .pkg.tar.zst (needs `package` first).
package-arch-bin:
    cd packaging/arch-bin && makepkg -f

# Build the Arch package from source (no prebuilt binary required).
package-arch:
    cd packaging/arch && makepkg -sf
