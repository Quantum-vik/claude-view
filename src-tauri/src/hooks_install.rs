use std::fs;
use std::path::PathBuf;

use serde_json::{json, Value};

/// Marker used to recognize our hook entries in settings.json so uninstall
/// removes exactly what install added, and nothing else.
const SCRIPT_MARKER: &str = "claude-view-hook";

const HOOK_EVENTS: &[&str] = &["SessionStart", "PreToolUse", "PostToolUse", "SessionEnd"];

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
fn hook_command(script: &PathBuf) -> String {
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
    // Keep a backup of the PRE-modification state. Only create it once (don't
    // clobber it on a later write, or uninstall would overwrite the original
    // snapshot with the already-installed state).
    let backup = path.with_extension("json.claude-view.bak");
    if path.exists() && !backup.exists() {
        if fs::copy(&path, &backup).is_ok() {
            // settings.json can hold secrets; keep the backup private.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&backup, fs::Permissions::from_mode(0o600));
            }
        }
    }
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| format!("write {}: {e}", path.display()))
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
