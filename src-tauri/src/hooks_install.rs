use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// Marker used to recognize our hook entries in settings.json so uninstall
/// removes exactly what install added, and nothing else.
const SCRIPT_MARKER: &str = "claude-view-hook";

const HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    // Marks the START of a turn. Without it, a turn that thinks for 90s before
    // touching a tool is indistinguishable from an idle session — PreToolUse is
    // the first signal we'd otherwise get, and it may never come.
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "SessionEnd",
    // Turn-completion + attention events drive "Claude is done" notifications.
    "Stop",
    "Notification",
];

#[cfg(not(windows))]
const BRIDGE_SCRIPT: &str = include_str!("../scripts/claude-view-hook.sh");
#[cfg(windows)]
const BRIDGE_SCRIPT: &str = include_str!("../scripts/claude-view-hook.ps1");

fn claude_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".claude"))
        .ok_or_else(|| "could not resolve home directory".to_string())
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(claude_dir()?.join("settings.json"))
}

fn script_path() -> Result<PathBuf, String> {
    #[cfg(not(windows))]
    let name = "claude-view-hook.sh";
    #[cfg(windows)]
    let name = "claude-view-hook.ps1";
    Ok(claude_dir()?.join("claude-view").join(name))
}

/// The `command` string placed in settings.json.
fn hook_command(script: &Path) -> String {
    #[cfg(not(windows))]
    {
        script.to_string_lossy().into_owned()
    }
    #[cfg(windows)]
    {
        format!(
            "powershell -NoProfile -ExecutionPolicy Bypass -File \"{}\"",
            script.to_string_lossy()
        )
    }
}

fn read_settings() -> Result<Value, String> {
    let path = settings_path()?;
    if !path.exists() {
        return Ok(json!({}));
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&text).map_err(|e| format!("{} is not valid JSON: {e}", path.display()))
}

fn write_settings(settings: &Value) -> Result<(), String> {
    let path = settings_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Many people symlink settings.json out of a dotfiles repo. Resolve it, or
    // the atomic rename below replaces the *link* with a regular file and
    // silently detaches them from their own config.
    let path = path.canonicalize().unwrap_or(path);

    // Keep a backup of the PRE-modification state. Only create it once (don't
    // clobber it on a later write, or uninstall would overwrite the original
    // snapshot with the already-installed state).
    let backup = path.with_extension("json.claude-view.bak");
    if path.exists() && !backup.exists() && fs::copy(&path, &backup).is_ok() {
        // settings.json can hold secrets; keep the backup private.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&backup, fs::Permissions::from_mode(0o600));
        }
    }

    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;

    // Round-trip verify before touching the real file. serde_json is built with
    // `preserve_order` so key order survives, but a verify still catches the
    // class of bug where we'd hand the user back a document that doesn't mean
    // what we think it means.
    let reparsed: Value = serde_json::from_str(&text)
        .map_err(|e| format!("refusing to write malformed settings.json: {e}"))?;
    if &reparsed != settings {
        return Err("refusing to write settings.json: serialization round-trip mismatch".into());
    }

    atomic_write(&path, text.as_bytes())
}

/// Write via a sibling temp file + rename, so a crash mid-write can't leave a
/// truncated (or empty) settings.json behind — which Claude Code refuses to
/// start with. `fs::write` truncates in place and has no such guarantee.
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;

    let dir = path.parent().ok_or("settings.json has no parent dir")?;
    let tmp = path.with_extension(format!("json.claude-view.tmp{}", std::process::id()));

    let mut file = fs::File::create(&tmp).map_err(|e| format!("create {}: {e}", tmp.display()))?;
    let result = file
        .write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("write {}: {e}", tmp.display()));
    drop(file);
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }

    // Carry the original's permissions over; File::create would otherwise apply
    // the umask default to a file the user may have deliberately locked down.
    if let Ok(meta) = fs::metadata(path) {
        let _ = fs::set_permissions(&tmp, meta.permissions());
    }

    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("replace {}: {e}", path.display()));
    }
    // Best-effort durability for the rename itself.
    if let Ok(d) = fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

fn entry_is_ours(entry: &Value) -> bool {
    entry["hooks"]
        .as_array()
        .map(|hooks| {
            hooks.iter().any(|h| {
                h["command"]
                    .as_str()
                    .map(|c| c.contains(SCRIPT_MARKER))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

pub fn installed() -> bool {
    read_settings()
        .ok()
        .and_then(|s| {
            s["hooks"].as_object().map(|events| {
                events
                    .values()
                    .filter_map(|v| v.as_array())
                    .flatten()
                    .any(entry_is_ours)
            })
        })
        .unwrap_or(false)
}

pub fn install() -> Result<String, String> {
    let script = script_path()?;
    let command = hook_command(&script);

    // 1. Validate and build the merged settings entirely in memory FIRST, so a
    //    malformed settings.json aborts before any filesystem side effects
    //    (no half-installed state where the script exists but settings don't).
    let mut settings = read_settings()?;
    if !settings.is_object() {
        return Err("~/.claude/settings.json root is not a JSON object".into());
    }
    let obj = settings.as_object_mut().unwrap();
    let hooks = obj
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("settings.json \"hooks\" is not an object")?;

    let mut added = 0;
    for event in HOOK_EVENTS {
        let list = hooks
            .entry(*event)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or_else(|| format!("settings.json hooks.{event} is not an array"))?;
        if list.iter().any(entry_is_ours) {
            continue;
        }
        // Tool events take a tool matcher; lifecycle events match everything
        // when no matcher is given.
        let entry = if matches!(*event, "PreToolUse" | "PostToolUse") {
            json!({ "matcher": "*", "hooks": [{ "type": "command", "command": command }] })
        } else {
            json!({ "hooks": [{ "type": "command", "command": command }] })
        };
        list.push(entry);
        added += 1;
    }

    // 2. Now that validation passed, materialize the bridge script under
    //    ~/.claude/claude-view/ so the hook block works regardless of where the
    //    app bundle lives.
    if let Some(parent) = script.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&script, BRIDGE_SCRIPT).map_err(|e| format!("write bridge script: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }

    if added > 0 {
        write_settings(&settings)?;
    }
    Ok(format!(
        "Hooks installed ({added} added). Bridge script: {}",
        script.display()
    ))
}

pub fn uninstall() -> Result<String, String> {
    let mut settings = read_settings()?;
    let mut removed = 0;
    if let Some(hooks) = settings["hooks"].as_object_mut() {
        let events: Vec<String> = hooks.keys().cloned().collect();
        for event in events {
            if let Some(list) = hooks[&event].as_array_mut() {
                let before = list.len();
                list.retain(|entry| !entry_is_ours(entry));
                removed += before - list.len();
                if list.is_empty() {
                    hooks.remove(&event);
                }
            }
        }
        if hooks.is_empty() {
            settings.as_object_mut().unwrap().remove("hooks");
        }
    }
    if removed > 0 {
        write_settings(&settings)?;
    }
    if let Ok(script) = script_path() {
        let _ = fs::remove_file(script);
    }
    Ok(format!("Hooks uninstalled ({removed} entries removed)."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn scratch(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("cv-hooks-{}-{n}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn top_level_keys(text: &str) -> Vec<String> {
        // Order-preserving read of the emitted document's top-level key order.
        let v: Value = serde_json::from_str(text).unwrap();
        v.as_object()
            .unwrap()
            .keys()
            .map(|k| k.to_string())
            .collect()
    }

    /// THE regression test for the highest-severity bug this change fixes.
    ///
    /// `~/.claude/settings.json` belongs to the user — they curate it, diff it,
    /// and commit it to dotfiles repos. Without serde_json's `preserve_order`
    /// feature, `Map` is a `BTreeMap`, so merely turning our hooks on
    /// alphabetizes and reflows their ENTIRE file: permissions, env, statusLine,
    /// MCP config, everything.
    ///
    /// If this test fails, `preserve_order` was dropped from Cargo.toml.
    #[test]
    fn rewriting_settings_preserves_the_users_key_order() {
        // Deliberately NOT alphabetical: a BTreeMap would reorder this to
        // env, hooks, permissions, statusLine.
        let original = r#"{
            "statusLine": {"type": "command"},
            "permissions": {"allow": ["Bash(ls:*)"]},
            "hooks": {},
            "env": {"FOO": "1"}
        }"#;
        let mut settings: Value = serde_json::from_str(original).unwrap();
        assert_eq!(
            top_level_keys(original),
            ["statusLine", "permissions", "hooks", "env"],
            "parsing must preserve order"
        );

        // Mutate the way install() does, then re-serialize.
        settings["hooks"]["SessionStart"] = json!([{ "hooks": [] }]);
        let emitted = serde_json::to_string_pretty(&settings).unwrap();

        assert_eq!(
            top_level_keys(&emitted),
            ["statusLine", "permissions", "hooks", "env"],
            "serializing must preserve order — is `preserve_order` still enabled?"
        );
    }

    /// Nested objects must keep their order too — `permissions` and `env` are
    /// the ones users actually notice being scrambled.
    #[test]
    fn nested_object_order_survives_a_rewrite() {
        let original = r#"{"env":{"ZED":"1","ALPHA":"2","MIDDLE":"3"}}"#;
        let settings: Value = serde_json::from_str(original).unwrap();
        let emitted = serde_json::to_string_pretty(&settings).unwrap();
        let reparsed: Value = serde_json::from_str(&emitted).unwrap();
        let keys: Vec<&str> = reparsed["env"]
            .as_object()
            .unwrap()
            .keys()
            .map(|k| k.as_str())
            .collect();
        assert_eq!(keys, ["ZED", "ALPHA", "MIDDLE"]);
    }

    #[test]
    fn atomic_write_replaces_content_and_leaves_no_temp_file() {
        let dir = scratch("atomic");
        let path = dir.join("settings.json");
        fs::write(&path, "old contents").unwrap();

        atomic_write(&path, b"new contents").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "new contents");
        // The temp sibling must be gone — a stray .tmp<pid> would accumulate.
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n != "settings.json")
            .collect();
        assert!(
            leftovers.is_empty(),
            "left temp files behind: {leftovers:?}"
        );
    }

    #[test]
    fn atomic_write_creates_a_file_that_did_not_exist() {
        let dir = scratch("create");
        let path = dir.join("settings.json");
        atomic_write(&path, b"{}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{}");
    }

    /// The permission carry-over exists so a user who chmod'd their settings
    /// file doesn't silently get it widened back to the umask default.
    #[cfg(unix)]
    #[test]
    fn atomic_write_carries_over_existing_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("perms");
        let path = dir.join("settings.json");
        fs::write(&path, "{}").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();

        atomic_write(&path, b"{\"a\":1}").unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "must not widen a locked-down settings.json");
    }

    /// `entry_is_ours` drives uninstall — it must not claim a hook we didn't
    /// install, and must recognize both the POSIX and PowerShell command forms.
    #[test]
    fn entry_ownership_matches_only_our_bridge() {
        assert!(entry_is_ours(&json!({
            "hooks": [{"type": "command", "command": "/Users/x/.claude/claude-view/claude-view-hook.sh"}]
        })));
        assert!(entry_is_ours(&json!({
            "hooks": [{"type": "command",
                       "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"C:\\x\\claude-view-hook.ps1\""}]
        })));
        assert!(!entry_is_ours(&json!({
            "hooks": [{"type": "command", "command": "/usr/local/bin/my-own-hook.sh"}]
        })));
        assert!(!entry_is_ours(&json!({ "hooks": [] })));
        assert!(!entry_is_ours(&json!({})));
    }

    /// UserPromptSubmit is what makes a tool-free thinking turn distinguishable
    /// from an idle session; without it the whole state model is wrong.
    #[test]
    fn hook_event_set_covers_turn_start_and_end() {
        for required in ["SessionStart", "UserPromptSubmit", "Stop", "Notification"] {
            assert!(
                HOOK_EVENTS.contains(&required),
                "{required} missing from HOOK_EVENTS"
            );
        }
    }
}
