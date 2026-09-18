# Packaging claude-view

Three downloadable artifacts, one per install style.

| Artifact | Extension | For | Install |
|---|---|---|---|
| AppImage | `.AppImage` | **any Linux** — Arch, Debian, Ubuntu, Fedora | `chmod +x` and run. No install, no root. |
| Debian package | `.deb` | Debian, Ubuntu, Mint, Pop!_OS | `sudo apt install ./claude-view_*.deb` |
| Arch package | `.pkg.tar.zst` | Arch, Omarchy, Manjaro, EndeavourOS | `sudo pacman -U claude-view-*.pkg.tar.zst` |

**The AppImage is the "single binary you can download"** — one file, no package
manager, no dependencies resolved at install time.

## Runtime dependency worth calling out

Tauri v2 needs **webkit2gtk-4.1**. Not 4.0 — the ABI differs, and a 4.0-only
system fails at launch, not at install. The `.deb` and `.pkg.tar.zst` both
declare it. The AppImage bundles most of its stack but still expects a working
system WebKit.

- Arch: `sudo pacman -S webkit2gtk-4.1`
- Debian/Ubuntu: `sudo apt install libwebkit2gtk-4.1-0`

## Building

```bash
APPIMAGE_EXTRACT_AND_RUN=1 npm run tauri build -- --bundles deb,appimage
```

**That env var is required on Arch**, and harmless everywhere else. linuxdeploy
is an AppImage that mounts itself via FUSE **2**; Arch ships only `fusermount3`,
so without it the `.deb` builds fine and the AppImage fails with `failed to run
linuxdeploy`. Extracting instead of mounting avoids needing root or `fuse2`.

Artifacts land in `src-tauri/target/release/bundle/{deb,appimage}/`.

Arch has no Tauri bundler target, so it gets a PKGBUILD instead:

```bash
# fast: repackage the binary you just built (seconds)
cd packaging/arch-bin && makepkg -f

# or from source, no prebuilt binary needed (minutes; needs rust + npm)
cd packaging/arch && makepkg -si
```

## Before shipping these publicly

- **The icon is a placeholder.** Replace `src-tauri/icons/icon.png` and
  regenerate with `npx tauri icon`.
- **Nothing is signed.** No GPG signature on the `.deb`, no code signing. Users
  will see the usual unsigned-package warnings.
- **Read the permissions section of the root README first.** Every session this
  app launches runs `claude --dangerously-skip-permissions` unless the launcher
  toggle is turned off. Shipping a binary that does that by default is a
  deliberate choice worth restating in any release notes.
