//! What a session changed on disk.
//!
//! The baseline is **derived, never stored** (#34): a session records
//! `spawned_at`, and git can say what HEAD was at that moment. The backend owns
//! no state for this, and past sessions get a baseline retroactively — one they
//! never could have recorded.
//!
//! This is the first code here to **spawn git**. `git.rs` walks `.git` by hand
//! because it answers one cheap question (where am I) on every poll; a diff is
//! not that question. Measured against `gix` and `git2` (#33): only the binary
//! answers `<base>` → working tree in a single call, `gix` has no tree→worktree
//! diff at all, and neither can render patch text without more work than the
//! subprocess costs.
//!
//! Three traps, each of which silently produces a *plausible wrong answer*:
//!
//! 1. **`git rev-parse` does not fail out of range.** Ask for a time before the
//!    reflog begins and it warns on stderr, returns the OLDEST entry, and exits
//!    **0**. `--verify` does not change this. So the range is checked against the
//!    oldest entry's timestamp *first*, and the sha is only then requested.
//! 2. **`--numstat` cannot see a mode change.** `chmod +x` with no content edit
//!    reports `0 0`, and `--name-status` reports a bare `M`. Only `--raw`
//!    carries the mode bits, so `--raw` is the spine and `--numstat` only adds
//!    churn.
//! 3. **`git diff <base>` never lists untracked files.** They are a separate
//!    question (`ls-files --others`), and the panel counts them as changes.

use serde::Serialize;
use std::path::Path;
use std::process::Command;

/// Why there is nothing to show. Each cause reads differently to a person, and
/// only some are actionable, so the panel renders one message per variant
/// rather than a single empty state (#34).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Unavailable {
    /// The cwd is not inside a git repository.
    NotARepo,
    /// The worktree no longer exists — routine for a past session.
    WorktreeGone,
    /// The repo has no commits, so there is nothing to measure from.
    NoCommits,
    /// The session started before the reflog's oldest entry (git keeps 90 days
    /// by default), so its starting point is gone.
    OlderThanReflog,
    /// git itself could not be run.
    GitUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    /// Set only for a rename, and it is git's *inference* from similarity — not
    /// something git recorded. The panel words it as such.
    pub old_path: Option<String>,
    /// `A` added, `M` modified, `D` deleted, `R` renamed, `U` untracked.
    pub status: char,
    pub add: u32,
    pub rem: u32,
    pub binary: bool,
    /// True when the file's mode changed, e.g. `100644` → `100755`. Invisible to
    /// `--numstat`; see the module docs.
    pub mode_changed: bool,
    pub old_mode: String,
    pub new_mode: String,
    /// Similarity score git assigned a rename, 0-100. `None` unless renamed.
    pub similarity: Option<u8>,
}

/// One commit made during the session: the drill-down unit (#36). Chosen over
/// the turn because commits are already in history — free to find, and they work
/// for a past session, where a per-turn capture would have had to be recorded
/// live and never can be.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSpan {
    pub sha: String,
    pub subject: String,
    /// Committer time, epoch seconds.
    pub ts: u64,
    pub files: Vec<String>,
    pub add: u32,
    pub rem: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub files: usize,
    pub add: u32,
    pub rem: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSet {
    /// Short sha the session is measured from. `None` when `unavailable` is set.
    pub baseline: Option<String>,
    pub head: Option<String>,
    pub files: Vec<ChangedFile>,
    pub spans: Vec<CommitSpan>,
    pub totals: Totals,
    /// Typed absence — never an empty success (#34).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable: Option<Unavailable>,
}

impl ChangeSet {
    fn absent(why: Unavailable) -> Self {
        Self {
            baseline: None,
            head: None,
            files: vec![],
            spans: vec![],
            totals: Totals::default(),
            unavailable: Some(why),
        }
    }
}

fn git(cwd: &Path, args: &[&str]) -> Result<String, ()> {
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(|_| ())?;
    if !out.status.success() {
        return Err(());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Format epoch millis as a local ISO timestamp git's approxidate accepts.
///
/// **Not** the bare unix number: `HEAD@{1234}` is the 1234th reflog *entry*, not
/// a time. Large values happen to parse as dates today; an explicit date can
/// never be read as an index.
fn iso_local(ms: u64) -> Option<String> {
    let out = Command::new("date")
        .arg("-d")
        .arg(format!("@{}", ms / 1000))
        .arg("+%Y-%m-%dT%H:%M:%S")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Oldest reflog entry for HEAD, epoch seconds.
fn oldest_reflog(cwd: &Path) -> Option<u64> {
    let out = git(cwd, &["reflog", "show", "--date=unix", "HEAD"]).ok()?;
    let last = out.lines().last()?;
    let start = last.find("HEAD@{")? + "HEAD@{".len();
    let end = last[start..].find('}')? + start;
    last[start..end].parse().ok()
}

/// HEAD as it stood when the session started.
///
/// The range check comes first and is the whole point: `git rev-parse` answers
/// an out-of-range time with the oldest entry and exit 0, so a caller that
/// trusts the exit code renders a diff over the wrong range.
pub fn baseline(cwd: &Path, spawned_at_ms: u64) -> Result<String, Unavailable> {
    if git(cwd, &["rev-parse", "--git-dir"]).is_err() {
        return Err(if cwd.exists() {
            Unavailable::NotARepo
        } else {
            Unavailable::WorktreeGone
        });
    }
    if git(cwd, &["rev-parse", "--verify", "HEAD"]).is_err() {
        return Err(Unavailable::NoCommits);
    }
    let oldest = oldest_reflog(cwd).ok_or(Unavailable::OlderThanReflog)?;
    if spawned_at_ms / 1000 < oldest {
        return Err(Unavailable::OlderThanReflog);
    }
    let when = iso_local(spawned_at_ms).ok_or(Unavailable::GitUnavailable)?;
    git(cwd, &["rev-parse", &format!("HEAD@{{{when}}}")])
        .map(|s| s.trim().to_string())
        .map_err(|_| Unavailable::OlderThanReflog)
}

/// Churn per path, from `--numstat`. A `-` count means binary.
fn churn(cwd: &Path, base: &str) -> Vec<(String, Option<u32>, Option<u32>)> {
    let Ok(out) = git(cwd, &["diff", "--numstat", "-M", base]) else {
        return vec![];
    };
    out.lines()
        .filter_map(|l| {
            let mut it = l.splitn(3, '\t');
            let a = it.next()?;
            let d = it.next()?;
            let p = it.next()?;
            // A rename's numstat path is `old => new`; --raw is authoritative
            // for the name, so only the counts are taken from here.
            Some((p.to_string(), a.parse().ok(), d.parse().ok()))
        })
        .collect()
}

fn parse_raw(line: &str, churn: &[(String, Option<u32>, Option<u32>)]) -> Option<ChangedFile> {
    // :<old-mode> <new-mode> <old-sha> <new-sha> <status>\t<path>[\t<new-path>]
    let (meta, rest) = line.split_once('\t')?;
    let mut f = meta.trim_start_matches(':').split_whitespace();
    let old_mode = f.next()?.to_string();
    let new_mode = f.next()?.to_string();
    let _old_sha = f.next()?;
    let _new_sha = f.next()?;
    let status_raw = f.next()?;
    let status = status_raw.chars().next()?;

    let (old_path, path) = if status == 'R' {
        let (o, n) = rest.split_once('\t')?;
        (Some(o.to_string()), n.to_string())
    } else {
        (None, rest.to_string())
    };

    let similarity = if status == 'R' {
        status_raw[1..].parse::<u8>().ok()
    } else {
        None
    };

    let hit = churn.iter().find(|(p, _, _)| {
        *p == path || old_path.as_deref().is_some_and(|o| p.contains(o) && p.contains(&path))
    });
    let (add, rem, binary) = match hit {
        Some((_, a, r)) => (a.unwrap_or(0), r.unwrap_or(0), a.is_none()),
        None => (0, 0, false),
    };

    Some(ChangedFile {
        path,
        old_path,
        status,
        add,
        rem,
        binary,
        // A pure mode change is `M` with differing modes and no churn; an add or
        // delete has a `000000` side and is not a mode change.
        mode_changed: old_mode != new_mode && status != 'A' && status != 'D',
        old_mode,
        new_mode,
        similarity,
    })
}

fn untracked(cwd: &Path) -> Vec<ChangedFile> {
    let Ok(out) = git(cwd, &["ls-files", "--others", "--exclude-standard"]) else {
        return vec![];
    };
    out.lines()
        .filter(|l| !l.is_empty())
        .map(|p| ChangedFile {
            path: p.to_string(),
            old_path: None,
            status: 'U',
            add: 0,
            rem: 0,
            binary: false,
            mode_changed: false,
            old_mode: "000000".into(),
            new_mode: "100644".into(),
            similarity: None,
        })
        .collect()
}

fn spans(cwd: &Path, base: &str) -> Vec<CommitSpan> {
    let Ok(out) = git(
        cwd,
        &["log", "--reverse", "--format=%H%x1f%ct%x1f%s", &format!("{base}..HEAD")],
    ) else {
        return vec![];
    };
    out.lines()
        .filter_map(|line| {
            let mut p = line.split('\u{1f}');
            let sha = p.next()?;
            let ts = p.next()?.parse().ok()?;
            let subject = p.next()?.to_string();
            let stat = git(cwd, &["show", "--numstat", "--format=", sha]).unwrap_or_default();
            let mut files = vec![];
            let (mut add, mut rem) = (0u32, 0u32);
            for l in stat.lines() {
                let mut it = l.splitn(3, '\t');
                let (a, d, p) = (it.next()?, it.next()?, it.next()?);
                add += a.parse::<u32>().unwrap_or(0);
                rem += d.parse::<u32>().unwrap_or(0);
                files.push(p.to_string());
            }
            Some(CommitSpan {
                sha: sha.chars().take(7).collect(),
                subject,
                ts,
                files,
                add,
                rem,
            })
        })
        .collect()
}

/// Everything the panel needs except patch text, which is fetched per file.
///
/// Patches are deliberately excluded: a 5,668-line `Cargo.lock` would otherwise
/// ride along in every response for a file nobody opened.
pub fn read(cwd: &Path, spawned_at_ms: u64) -> ChangeSet {
    let base = match baseline(cwd, spawned_at_ms) {
        Ok(b) => b,
        Err(why) => return ChangeSet::absent(why),
    };
    let ch = churn(cwd, &base);
    let raw = git(cwd, &["diff", "--raw", "-M", &base]).unwrap_or_default();
    let mut files: Vec<ChangedFile> = raw
        .lines()
        .filter(|l| l.starts_with(':'))
        .filter_map(|l| parse_raw(l, &ch))
        .collect();
    files.extend(untracked(cwd));

    let totals = Totals {
        files: files.len(),
        add: files.iter().map(|f| f.add).sum(),
        rem: files.iter().map(|f| f.rem).sum(),
    };
    ChangeSet {
        head: git(cwd, &["rev-parse", "HEAD"])
            .ok()
            .map(|s| s.trim().chars().take(7).collect()),
        baseline: Some(base.chars().take(7).collect()),
        spans: spans(cwd, &base),
        files,
        totals,
        unavailable: None,
    }
}

/// Unified patch for one file, fetched when it is opened.
pub fn patch(cwd: &Path, spawned_at_ms: u64, path: &str) -> Result<String, String> {
    let base = baseline(cwd, spawned_at_ms).map_err(|_| "no baseline".to_string())?;
    // `--` guards a path that looks like a revision.
    git(cwd, &["diff", "-M", &base, "--", path]).map_err(|_| "git diff failed".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);

    fn scratch(tag: &str) -> PathBuf {
        let n = N.fetch_add(1, Ordering::SeqCst);
        let d = std::env::temp_dir().join(format!("cv-chg-{}-{n}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn sh(cwd: &Path, args: &[&str]) -> String {
        let out = Command::new("git").arg("-C").arg(cwd).args(args).output().unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A repo with one commit, and an identity that does not depend on the
    /// developer's global gitconfig.
    fn repo(tag: &str) -> PathBuf {
        let d = scratch(tag);
        sh(&d, &["init", "-q", "-b", "main"]);
        sh(&d, &["config", "user.email", "t@example.invalid"]);
        sh(&d, &["config", "user.name", "T"]);
        fs::write(d.join("a.txt"), "one\n").unwrap();
        sh(&d, &["add", "a.txt"]);
        sh(&d, &["commit", "-qm", "first"]);
        d
    }

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    }

    /// Run the real thing against this repo and print what it finds, so the
    /// numbers can be checked against git by hand. Opt-in:
    /// `CV_DUMP_CHANGES=<epoch-ms> cargo test dump_changes -- --nocapture`.
    #[test]
    fn dump_changes() {
        let Ok(ms) = std::env::var("CV_DUMP_CHANGES") else {
            return;
        };
        let cwd = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
        let cs = read(&cwd, ms.parse().unwrap());
        eprintln!(
            "baseline {:?} -> {:?}: {} files, +{}/-{}, {} spans",
            cs.baseline, cs.head, cs.totals.files, cs.totals.add, cs.totals.rem, cs.spans.len()
        );
        let modes: Vec<_> = cs.files.iter().filter(|f| f.mode_changed).map(|f| &f.path).collect();
        let renames: Vec<_> = cs.files.iter().filter(|f| f.status == 'R').map(|f| &f.path).collect();
        let binaries: Vec<_> = cs.files.iter().filter(|f| f.binary).map(|f| &f.path).collect();
        let untracked: Vec<_> = cs.files.iter().filter(|f| f.status == 'U').map(|f| &f.path).collect();
        eprintln!("mode changes: {modes:?}");
        eprintln!("renames: {renames:?}");
        eprintln!("binaries: {binaries:?}");
        eprintln!("untracked: {untracked:?}");
    }

    #[test]
    fn a_directory_outside_any_repo_says_so() {
        let d = scratch("norepo");
        assert_eq!(baseline(&d, now_ms()), Err(Unavailable::NotARepo));
        assert_eq!(read(&d, now_ms()).unavailable, Some(Unavailable::NotARepo));
    }

    #[test]
    fn a_directory_that_no_longer_exists_is_not_confused_with_a_non_repo() {
        let d = scratch("gone");
        fs::remove_dir_all(&d).unwrap();
        assert_eq!(baseline(&d, now_ms()), Err(Unavailable::WorktreeGone));
    }

    #[test]
    fn an_empty_repo_has_nothing_to_measure_from() {
        let d = scratch("empty");
        sh(&d, &["init", "-q", "-b", "main"]);
        assert_eq!(baseline(&d, now_ms()), Err(Unavailable::NoCommits));
    }

    /// The trap. `git rev-parse` answers a time before the reflog with the
    /// OLDEST entry and exit code 0 — so a caller that trusts the exit code
    /// silently measures from the wrong commit. Absence must be detected by
    /// comparing timestamps, and this test fails if that check is removed.
    #[test]
    fn a_session_older_than_the_reflog_has_no_baseline_rather_than_the_wrong_one() {
        let d = repo("old");
        let ancient = 1_000_000_000_000u64; // 2001

        // What git says on its own, for the record:
        let out = Command::new("git")
            .arg("-C")
            .arg(&d)
            .args(["rev-parse", "--verify", "HEAD@{2001-09-09T01:46:40}"])
            .output()
            .unwrap();
        assert!(out.status.success(), "git exits 0 out of range — that is the trap");
        assert!(!String::from_utf8_lossy(&out.stdout).trim().is_empty());

        assert_eq!(baseline(&d, ancient), Err(Unavailable::OlderThanReflog));
    }

    #[test]
    fn the_baseline_is_the_commit_head_pointed_at_when_the_session_started() {
        let d = repo("base");
        let first = sh(&d, &["rev-parse", "HEAD"]);
        let started = now_ms();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        fs::write(d.join("a.txt"), "two\n").unwrap();
        sh(&d, &["commit", "-qam", "second"]);

        assert_eq!(baseline(&d, started).unwrap(), first);
        let cs = read(&d, started);
        assert_eq!(cs.baseline.unwrap(), first[..7]);
        // The work landed in a commit, so it is invisible to a working-tree
        // diff and must still be reported.
        assert_eq!(cs.files.len(), 1, "committed work must still count");
        assert_eq!(cs.spans.len(), 1);
        assert_eq!(cs.spans[0].subject, "second");
    }

    #[test]
    fn untracked_files_count_even_though_git_diff_never_lists_them() {
        let d = repo("untracked");
        let started = now_ms();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        fs::write(d.join("new.txt"), "hello\n").unwrap();

        let raw = sh(&d, &["diff", "--raw", "HEAD"]);
        assert!(raw.is_empty(), "git diff is blind to untracked files");

        let cs = read(&d, started);
        assert!(cs.files.iter().any(|f| f.path == "new.txt" && f.status == 'U'));
    }

    #[test]
    fn ignored_files_do_not_count() {
        let d = repo("ignored");
        fs::write(d.join(".gitignore"), "build/\n").unwrap();
        sh(&d, &["add", ".gitignore"]);
        sh(&d, &["commit", "-qm", "ignore"]);
        let started = now_ms();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        fs::create_dir_all(d.join("build")).unwrap();
        fs::write(d.join("build/out.bin"), "x\n").unwrap();

        let cs = read(&d, started);
        assert!(!cs.files.iter().any(|f| f.path.starts_with("build/")));
    }

    /// `--numstat` reports a mode-only change as `0 0` and `--name-status` as a
    /// bare `M`. Only `--raw` carries the bits, which is why it is the spine.
    #[test]
    fn a_mode_only_change_is_seen_even_though_numstat_reports_no_churn() {
        let d = repo("mode");
        let started = now_ms();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        // chmod on disk, which is what actually happens to a script — not
        // `update-index --chmod`, which moves the index and leaves the
        // filesystem (and therefore `git diff <base>`) untouched.
        use std::os::unix::fs::PermissionsExt;
        let f = d.join("a.txt");
        let mut perm = fs::metadata(&f).unwrap().permissions();
        perm.set_mode(0o755);
        fs::set_permissions(&f, perm).unwrap();

        let numstat = sh(&d, &["diff", "--numstat", "HEAD"]);
        assert!(numstat.starts_with("0\t0"), "numstat sees no churn: {numstat:?}");

        let cs = read(&d, started);
        let f = cs.files.iter().find(|f| f.path == "a.txt").expect("file missing");
        assert!(f.mode_changed);
        assert_eq!(f.old_mode, "100644");
        assert_eq!(f.new_mode, "100755");
    }

    #[test]
    fn a_rename_is_one_row_carrying_where_it_came_from() {
        let d = repo("rename");
        fs::write(d.join("big.txt"), (0..80).map(|i| format!("line {i}\n")).collect::<String>()).unwrap();
        sh(&d, &["add", "big.txt"]);
        sh(&d, &["commit", "-qm", "big"]);
        let started = now_ms();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        sh(&d, &["mv", "big.txt", "moved.txt"]);
        sh(&d, &["commit", "-qm", "move"]);

        let cs = read(&d, started);
        let f = cs.files.iter().find(|f| f.status == 'R').expect("no rename detected");
        assert_eq!(f.path, "moved.txt");
        assert_eq!(f.old_path.as_deref(), Some("big.txt"));
        assert_eq!(f.similarity, Some(100));
        assert_eq!(cs.files.len(), 1, "a rename is ONE row, not a delete plus an add");
    }

    #[test]
    fn a_deleted_file_is_reported_with_its_lost_lines() {
        let d = repo("delete");
        let started = now_ms();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        sh(&d, &["rm", "-q", "a.txt"]);
        sh(&d, &["commit", "-qm", "remove"]);

        let cs = read(&d, started);
        let f = cs.files.iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!(f.status, 'D');
        assert_eq!(f.rem, 1);
        assert!(!f.mode_changed, "a delete is not a mode change");
    }

    #[test]
    fn a_binary_file_is_flagged_rather_than_given_a_line_count() {
        let d = repo("binary");
        let started = now_ms();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        fs::write(d.join("blob.bin"), [0u8, 159, 146, 150, 0, 1, 2]).unwrap();
        sh(&d, &["add", "blob.bin"]);
        sh(&d, &["commit", "-qm", "blob"]);

        let cs = read(&d, started);
        let f = cs.files.iter().find(|f| f.path == "blob.bin").unwrap();
        assert!(f.binary);
        assert_eq!((f.add, f.rem), (0, 0));
    }

    #[test]
    fn a_session_that_changed_nothing_is_a_success_with_no_files() {
        let d = repo("quiet");
        let cs = read(&d, now_ms());
        assert!(cs.unavailable.is_none(), "nothing changed is not a failure");
        assert!(cs.files.is_empty());
        assert_eq!(cs.totals.files, 0);
    }

    #[test]
    fn commit_spans_are_ordered_oldest_first_and_carry_their_files() {
        let d = repo("spans");
        let started = now_ms();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        for (i, name) in ["one", "two", "three"].iter().enumerate() {
            fs::write(d.join(format!("f{i}.txt")), "x\n").unwrap();
            sh(&d, &["add", "."]);
            sh(&d, &["commit", "-qm", name]);
        }
        let cs = read(&d, started);
        let subjects: Vec<_> = cs.spans.iter().map(|s| s.subject.as_str()).collect();
        assert_eq!(subjects, vec!["one", "two", "three"]);
        assert_eq!(cs.spans[0].files, vec!["f0.txt"]);
        assert!(cs.spans.iter().all(|s| s.add > 0));
    }

    #[test]
    fn patch_text_is_fetched_per_file_not_bundled_into_the_listing() {
        let d = repo("patch");
        let started = now_ms();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        fs::write(d.join("a.txt"), "one\ntwo\n").unwrap();
        sh(&d, &["commit", "-qam", "edit"]);

        let cs = read(&d, started);
        let serialized = serde_json::to_string(&cs).unwrap();
        assert!(!serialized.contains("+two"), "listing must not carry patch text");

        let p = patch(&d, started, "a.txt").unwrap();
        assert!(p.contains("+two"));
    }
}
