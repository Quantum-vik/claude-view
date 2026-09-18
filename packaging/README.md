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

`APPIMAGE_EXTRACT_AND_RUN=1` is needed on Arch and harmless elsewhere:
linuxdeploy is itself an AppImage and mounts via FUSE **2**, but Arch ships only
`fusermount3`.

### The AppImage does not currently build on modern Arch

It is **not** shipped in v1.0.0. The `.deb` and `.pkg.tar.zst` are.

The blocker is *not* FUSE. `gdk-pixbuf2` 2.44+ compiles its image loaders into
the library and ships no `/usr/lib/gdk-pixbuf-2.0/2.10.0/` directory at all —
but `pkg-config` still advertises that path:

```
$ pkg-config --variable=gdk_pixbuf_binarydir gdk-pixbuf-2.0
/usr/lib/gdk-pixbuf-2.0/2.10.0          # does not exist
```

`linuxdeploy-plugin-gtk` copies that path unconditionally and dies with
`cp: cannot stat`, which Tauri surfaces only as `failed to run linuxdeploy` —
the real message is two layers down. Run linuxdeploy directly to see it:

```bash
cd src-tauri/target/release/bundle/appimage
APPIMAGE_EXTRACT_AND_RUN=1 ~/.cache/tauri/linuxdeploy-x86_64.AppImage \
  --appdir claude-view.AppDir --plugin gtk --output appimage
```

A working no-root workaround is a shadowed `.pc` on `PKG_CONFIG_PATH` whose
`gdk_pixbuf_binarydir` points at a directory that exists and holds a generated
`loaders.cache`. It builds, but it changes `PKG_CONFIG_PATH`, which invalidates
the cargo cache and forces a full GTK recompile — so it is left out of the
default recipe rather than imposed on every build. Building the AppImage on a
distro with the traditional gdk-pixbuf layout (Debian, Ubuntu) avoids the
problem entirely, and is the better home for it anyway.

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
