//! Instance discovery files — how the hook bridge script (and local tooling)
//! finds a running app's port and auth token.
//!
//! Layout under `~/.claude/claude-view/`:
//!
//! ```text
//! instances/<port>.json   canonical: one file per running instance
//! instance.json           legacy single-file copy, kept for compatibility
//! ```
//!
//! **Why per-port.** The bridge only trusts a discovery file whose `port`
//! matches the session's `CLAUDE_VIEW_PORT`, and exits 0 on a mismatch. With a
//! single shared `instance.json`, a *second* app instance overwrote the first's
//! file, so every session belonging to the first silently stopped delivering
//! hooks — no timeline, no state, and no error anywhere to explain it. Naming
//! the file after the port means two instances cannot collide at all, and the
//! bridge's port check collapses into looking up a path it already knows.
//!
//! **Why the permissions matter.** The token in these files grants PTY write on
//! every session, shell spawn in any cwd, and enumeration of every transcript.
//! It is deliberately kept out of the child environment for exactly that
//! reason, so the file must never be readable by another local user — not even
//! for the instant between `fs::write` and a follow-up `chmod`. Everything here
//! creates the file private (`O_CREAT|O_EXCL` with mode 0600) and renames it
//! into place; `O_EXCL` also means a symlink planted at the path is refused
//! rather than followed.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::json;

/// `~/.claude/claude-view` — the directory both discovery files live under.
pub fn default_root() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("claude-view"))
}

fn instances_dir(root: &Path) -> PathBuf {
    root.join("instances")
}

fn legacy_path(root: &Path) -> PathBuf {
    root.join("instance.json")
}

fn port_path(root: &Path, port: u16) -> PathBuf {
    instances_dir(root).join(format!("{port}.json"))
}

/// Publish this instance's `{port, token, pid}` under `root`.
///
/// Writes `instances/<port>.json` (canonical) and `instance.json` (legacy, for
/// bridge scripts and helper scripts that predate the per-port layout). The
/// legacy file is last-writer-wins across instances by design: it can only ever
/// describe one of them, and the per-port file is what makes hook delivery
/// correct regardless.
pub fn publish(root: &Path, port: u16, token: &str, pid: u32) -> Result<(), String> {
    let body = json!({ "port": port, "token": token, "pid": pid }).to_string();

    ensure_private_dir(root).map_err(|e| format!("create {}: {e}", root.display()))?;
    let dir = instances_dir(root);
    ensure_private_dir(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    let path = port_path(root, port);
    write_private(&path, body.as_bytes()).map_err(|e| format!("write {}: {e}", path.display()))?;

    let legacy = legacy_path(root);
    write_private(&legacy, body.as_bytes())
        .map_err(|e| format!("write {}: {e}", legacy.display()))?;
    Ok(())
}

/// Delete discovery files left behind by instances that are no longer running.
///
/// `RunEvent::Exit` never fires on a crash or `kill -9`, so without this a dead
/// instance's file survives and keeps advertising a port nothing is listening
/// on. A file whose JSON is malformed or truncated (a half-written file from an
/// older, non-atomic build) carries no usable pid and is treated as stale too.
pub fn reap_stale(root: &Path) {
    reap_stale_with(root, pid_alive);
}

fn reap_stale_with(root: &Path, alive: impl Fn(u32) -> bool) {
    let is_stale = |path: &Path| match read_pid(path) {
        Some(pid) => !alive(pid),
        // No readable pid => nothing can vouch for it. Dropping it is safe:
        // a live instance rewrites its own file on every launch.
        None => true,
    };

    if let Ok(entries) = fs::read_dir(instances_dir(root)) {
        for entry in entries.flatten() {
            let path = entry.path();
            // Only ever consider `<port>.json`; this skips the `.tmp<pid>`
            // siblings write_private uses, and anything else that wanders in.
            if path.extension().is_some_and(|e| e == "json") && is_stale(&path) {
                let _ = fs::remove_file(&path);
            }
        }
    }

    let legacy = legacy_path(root);
    if legacy.is_file() && is_stale(&legacy) {
        let _ = fs::remove_file(&legacy);
    }
}

/// Remove the discovery files this process owns, and only those.
///
/// Quitting one instance must not delete another's: the legacy `instance.json`
/// may well belong to an instance that is still running, and deleting it would
/// break that instance's bridge on the fallback path.
pub fn cleanup(root: &Path, pid: u32) {
    let ours = |path: &Path| read_pid(path) == Some(pid);

    if let Ok(entries) = fs::read_dir(instances_dir(root)) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "json") && ours(&path) {
                let _ = fs::remove_file(&path);
            }
        }
    }

    let legacy = legacy_path(root);
    if ours(&legacy) {
        let _ = fs::remove_file(&legacy);
    }
}

/// `pid` out of a discovery file, or `None` if the file is missing, unreadable,
/// or not JSON we recognize. Never panics on a truncated or garbage file.
fn read_pid(path: &Path) -> Option<u32> {
    let text = fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    u32::try_from(value.get("pid")?.as_u64()?).ok()
}

/// Is a process with this pid running?
///
/// `kill(pid, 0)` runs the existence/permission check without delivering a
/// signal. The cast is guarded because pid 0 means "my process group" and a
/// negative pid means "every process" — either would report a dead instance as
/// alive. `EPERM` means the process exists but belongs to another user, which
/// still counts as alive.
///
/// pids are recycled, so a long-dead instance's file can in principle be held
/// alive by an unrelated process that inherited its number. The cost is one
/// stale file that the next instance on that port overwrites.
#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Windows: assume alive, never reap.
///
/// A real check needs `OpenProcess` from `windows-sys`, and guessing wrong in
/// the other direction — reaping a *live* instance's file — silently kills hook
/// delivery for a running app, which is the exact failure this module exists to
/// fix. Assuming alive only ever leaves a stale file behind; it is overwritten
/// by the next instance that binds that port, and now that files are per-port
/// it can no longer misroute a different instance's sessions.
#[cfg(not(unix))]
fn pid_alive(_pid: u32) -> bool {
    true
}

/// Create `dir` (and parents) readable only by its owner, tightening it if an
/// older build already created it with the umask default. The token file is
/// only as private as the path leading to it.
fn ensure_private_dir(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
        // mkdir's mode is masked by the umask; set_permissions is not, and it
        // also fixes a directory that already existed at 0755.
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(dir)
    }
}

/// Write `bytes` to `path` through a private temp sibling + rename.
///
/// Two properties this has and `fs::write` + `set_permissions` does not:
/// the file is 0600 from the instant it exists (no window at the umask default
/// where another local user can read the token), and `O_EXCL` refuses to follow
/// a symlink, so an attacker cannot plant one at the path to redirect the
/// write. The final `rename` replaces a symlink sitting at the *target* rather
/// than writing through it, and makes the swap atomic for concurrent readers.
///
/// Also used for the `settings.json` backup in `hooks_install`, which has the
/// same "must never be briefly world-readable" requirement.
pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;

    let tmp = tmp_path(path)?;
    // A leftover temp sibling (crash mid-write, or one planted deliberately)
    // must not wedge every future write: unlink it and retry. `remove_file`
    // removes a symlink itself, never its target.
    let mut file = None;
    for _ in 0..4 {
        match create_private(&tmp) {
            Ok(f) => {
                file = Some(f);
                break;
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                fs::remove_file(&tmp)?;
            }
            Err(e) => return Err(e),
        }
    }
    let Some(mut file) = file else {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("could not claim temp file {}", tmp.display()),
        ));
    };

    let written = file.write_all(bytes).and_then(|_| file.sync_all());
    drop(file);
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// Hidden sibling of `path`, in the same directory so the rename stays on one
/// filesystem. The name deliberately does not end in `.json`, so a temp file
/// racing with a scan is never mistaken for a discovery file.
fn tmp_path(path: &Path) -> io::Result<PathBuf> {
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;
    Ok(dir.join(format!(".{name}.tmp{}", std::process::id())))
}

/// `O_CREAT | O_EXCL | O_WRONLY` with mode 0600: never widens, never follows a
/// symlink, never truncates something that was already there.
fn create_private(path: &Path) -> io::Result<fs::File> {
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// A private scratch root per test. Deliberately NOT `$HOME` and not an env
    /// var: `std::env::var` is process-global, so an env-var-configured root
    /// would race between tests running in parallel.
    fn scratch(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("cv-inst-{}-{n}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(unix)]
    fn mode_of(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    fn write_record(path: &Path, pid: u32) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            path,
            json!({"port": 1, "token": "t", "pid": pid}).to_string(),
        )
        .unwrap();
    }

    #[test]
    fn publish_writes_both_the_per_port_and_the_legacy_file() {
        let root = scratch("publish");
        publish(&root, 4242, "sekrit", 99).unwrap();

        for path in [port_path(&root, 4242), legacy_path(&root)] {
            let text = fs::read_to_string(&path).unwrap();
            let v: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(v["port"], 4242);
            assert_eq!(v["token"], "sekrit");
            assert_eq!(v["pid"], 99);
        }
    }

    /// Two instances must not clobber each other — the whole point of naming
    /// the file after the port. Before this, instance B starting up silently
    /// stopped hook delivery for every one of instance A's sessions.
    #[test]
    fn two_instances_on_different_ports_keep_their_own_files() {
        let root = scratch("two");
        publish(&root, 111, "token-a", 1).unwrap();
        publish(&root, 222, "token-b", 2).unwrap();

        let a = fs::read_to_string(port_path(&root, 111)).unwrap();
        let b = fs::read_to_string(port_path(&root, 222)).unwrap();
        assert!(
            a.contains("token-a"),
            "instance A's file was clobbered: {a}"
        );
        assert!(b.contains("token-b"));
    }

    /// The token grants full control of every session. It must be 0600 from the
    /// instant the file exists, which is why the mode comes from the `open`
    /// flags rather than a chmod after the fact.
    #[cfg(unix)]
    #[test]
    fn discovery_files_and_their_directories_are_owner_only() {
        let root = scratch("perms");
        publish(&root, 4242, "sekrit", 99).unwrap();

        assert_eq!(mode_of(&port_path(&root, 4242)), 0o600);
        assert_eq!(mode_of(&legacy_path(&root)), 0o600);
        assert_eq!(mode_of(&instances_dir(&root)), 0o700);
        assert_eq!(mode_of(&root), 0o700);
    }

    /// The "never *briefly* wider" half: the file is created with mode 0600 by
    /// `open` itself, so there is no window between creation and a chmod where
    /// another local user could read the token.
    #[cfg(unix)]
    #[test]
    fn a_freshly_created_file_is_already_0600_before_any_chmod() {
        let root = scratch("fresh");
        let path = root.join("brand-new");
        let file = create_private(&path).unwrap();
        assert_eq!(mode_of(&path), 0o600, "mode must come from open(2)");
        drop(file);
    }

    /// An older build's `create_dir_all` left this directory at 0755. Publishing
    /// tightens it, because the token file is only as private as its path.
    #[cfg(unix)]
    #[test]
    fn publishing_tightens_a_directory_an_older_build_left_world_readable() {
        use std::os::unix::fs::PermissionsExt;
        let root = scratch("tighten");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();

        publish(&root, 4242, "sekrit", 99).unwrap();

        assert_eq!(mode_of(&root), 0o700);
    }

    /// `fs::write` follows a symlink planted at the target, letting an attacker
    /// redirect the token wherever they like. `O_EXCL` + rename does not: the
    /// link is replaced, and whatever it pointed at is untouched.
    #[cfg(unix)]
    #[test]
    fn a_symlink_planted_at_the_target_is_replaced_not_followed() {
        let root = scratch("symlink");
        let victim = root.join("victim");
        fs::write(&victim, "do not overwrite me").unwrap();
        let target = root.join("instance.json");
        std::os::unix::fs::symlink(&victim, &target).unwrap();

        write_private(&target, b"{\"pid\":1}").unwrap();

        assert_eq!(fs::read_to_string(&victim).unwrap(), "do not overwrite me");
        assert_eq!(fs::read_to_string(&target).unwrap(), "{\"pid\":1}");
        assert!(
            !fs::symlink_metadata(&target).unwrap().is_symlink(),
            "the symlink must have been replaced by a real file"
        );
        assert_eq!(mode_of(&target), 0o600);
    }

    /// Same, for a symlink planted at the *temp* path we write through — the
    /// window an attacker would actually race for.
    #[cfg(unix)]
    #[test]
    fn a_symlink_planted_at_the_temp_path_is_unlinked_not_followed() {
        let root = scratch("symlink-tmp");
        let victim = root.join("victim");
        fs::write(&victim, "do not overwrite me").unwrap();
        let target = root.join("instance.json");
        std::os::unix::fs::symlink(&victim, tmp_path(&target).unwrap()).unwrap();

        write_private(&target, b"{\"pid\":1}").unwrap();

        assert_eq!(fs::read_to_string(&victim).unwrap(), "do not overwrite me");
        assert_eq!(fs::read_to_string(&target).unwrap(), "{\"pid\":1}");
    }

    /// Republishing must swap in a *new* file rather than truncate the old one
    /// in place. A new inode is what proves the token was written through a
    /// freshly-created 0600 file and renamed over the target, instead of
    /// `fs::write`-ing into whatever was already sitting at that path (and only
    /// then chmod'ing it). It also means a reader never sees a half-written
    /// file.
    #[cfg(unix)]
    #[test]
    fn republishing_swaps_in_a_new_file_rather_than_truncating_in_place() {
        use std::os::unix::fs::MetadataExt;
        let root = scratch("inode");
        publish(&root, 4242, "old", 1).unwrap();
        let path = port_path(&root, 4242);
        let before = fs::metadata(&path).unwrap().ino();

        publish(&root, 4242, "new", 2).unwrap();

        let after = fs::metadata(&path).unwrap().ino();
        assert_ne!(before, after, "wrote in place instead of renaming");
        assert_eq!(mode_of(&path), 0o600);
    }

    /// A leftover temp sibling from a crashed write must not wedge every future
    /// publish.
    #[test]
    fn a_stale_temp_sibling_does_not_block_the_write() {
        let root = scratch("squatter");
        let target = root.join("instance.json");
        fs::write(tmp_path(&target).unwrap(), "leftover").unwrap();

        write_private(&target, b"fresh").unwrap();

        assert_eq!(fs::read_to_string(&target).unwrap(), "fresh");
        assert!(!tmp_path(&target).unwrap().exists());
    }

    #[test]
    fn publish_leaves_no_temp_files_behind() {
        let root = scratch("no-temp");
        publish(&root, 4242, "sekrit", 99).unwrap();

        let stray: Vec<String> = fs::read_dir(&root)
            .unwrap()
            .chain(fs::read_dir(instances_dir(&root)).unwrap())
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp"))
            .collect();
        assert!(stray.is_empty(), "left temp files behind: {stray:?}");
    }

    /// A crash or `kill -9` skips the exit handler, so the file outlives the
    /// process. Startup has to clean up after it.
    #[test]
    fn reaping_deletes_a_dead_pid_and_keeps_a_live_one() {
        let root = scratch("reap");
        write_record(&port_path(&root, 111), 1); // dead
        write_record(&port_path(&root, 222), 2); // live
        write_record(&legacy_path(&root), 1); // dead

        reap_stale_with(&root, |pid| pid == 2);

        assert!(!port_path(&root, 111).exists(), "dead instance not reaped");
        assert!(port_path(&root, 222).exists(), "live instance was reaped");
        assert!(!legacy_path(&root).exists(), "stale legacy file not reaped");
    }

    #[test]
    fn reaping_keeps_a_legacy_file_owned_by_a_live_instance() {
        let root = scratch("reap-legacy");
        write_record(&legacy_path(&root), 2);

        reap_stale_with(&root, |pid| pid == 2);

        assert!(legacy_path(&root).exists());
    }

    /// A half-written file from an older, non-atomic build carries no usable
    /// pid. Treat it as stale — and above all, do not panic parsing it.
    #[test]
    fn malformed_and_truncated_files_are_treated_as_stale() {
        let root = scratch("malformed");
        let dir = instances_dir(&root);
        fs::create_dir_all(&dir).unwrap();
        let cases = [
            ("1.json", ""),
            ("2.json", "{\"port\":1,\"token\":\"t\",\"pi"), // truncated
            ("3.json", "not json at all"),
            ("4.json", "{}"),              // valid JSON, no pid
            ("5.json", "{\"pid\":\"7\"}"), // pid is a string
            ("6.json", "{\"pid\":-1}"),    // pid is negative
            ("7.json", "[1,2,3]"),         // JSON, but not an object
            ("8.json", "{\"pid\":1e400}"), // number that isn't a u64
        ];
        for (name, body) in cases {
            fs::write(dir.join(name), body).unwrap();
        }

        // `alive` claims everything is alive: only the unreadable-pid rule can
        // remove these.
        reap_stale_with(&root, |_| true);

        for (name, body) in cases {
            assert!(
                !dir.join(name).exists(),
                "{name} ({body:?}) should have been reaped as stale"
            );
        }
    }

    #[test]
    fn reaping_ignores_files_that_are_not_discovery_files() {
        let root = scratch("ignore");
        let dir = instances_dir(&root);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("README"), "hi").unwrap();
        fs::write(dir.join(".1.json.tmp999"), "partial").unwrap();

        reap_stale_with(&root, |_| false);

        assert!(dir.join("README").exists());
        assert!(dir.join(".1.json.tmp999").exists());
    }

    #[test]
    fn reaping_a_missing_root_is_a_no_op() {
        let root = scratch("missing").join("does-not-exist");
        reap_stale_with(&root, |_| false);
        cleanup(&root, 1);
    }

    /// Quitting instance B must not delete instance A's files — that is the
    /// bug the unconditional `remove_file` on exit had.
    #[test]
    fn cleanup_removes_only_our_own_files() {
        let root = scratch("cleanup");
        write_record(&port_path(&root, 111), 1); // ours
        write_record(&port_path(&root, 222), 2); // someone else's
        write_record(&legacy_path(&root), 2); // someone else's

        cleanup(&root, 1);

        assert!(!port_path(&root, 111).exists(), "our file was not removed");
        assert!(port_path(&root, 222).exists(), "another pid's file removed");
        assert!(legacy_path(&root).exists(), "another pid's legacy removed");
    }

    #[test]
    fn cleanup_removes_the_legacy_file_when_it_is_ours() {
        let root = scratch("cleanup-legacy");
        publish(&root, 4242, "sekrit", 4321).unwrap();

        cleanup(&root, 4321);

        assert!(!port_path(&root, 4242).exists());
        assert!(!legacy_path(&root).exists());
    }

    /// The publish -> crash -> restart cycle end to end: the survivor is
    /// reaped, and a fresh publish takes its place.
    #[test]
    fn a_restart_reaps_the_previous_runs_file_and_republishes() {
        let root = scratch("restart");
        publish(&root, 4242, "old-token", 1).unwrap();

        reap_stale_with(&root, |pid| pid != 1);
        assert!(!port_path(&root, 4242).exists(), "crashed run not reaped");

        publish(&root, 4242, "new-token", 2).unwrap();
        let text = fs::read_to_string(port_path(&root, 4242)).unwrap();
        assert!(text.contains("new-token"));
    }

    /// The real liveness check, exercised on the one pid we can be sure about.
    #[cfg(unix)]
    #[test]
    fn our_own_pid_is_alive_and_impossible_pids_are_not() {
        assert!(pid_alive(std::process::id()));
        // 0 is "my process group" and u32::MAX casts to -1, "every process" —
        // both would make kill(2) succeed and report a dead instance as alive.
        assert!(!pid_alive(0));
        assert!(!pid_alive(u32::MAX));
    }
}
