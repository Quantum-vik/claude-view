//! Repo identity for a session's working directory.
//!
//! Pure filesystem walking — no `git` subprocess, no new crate. The launcher
//! needs to group four agents running on four *worktrees of one repo* under
//! that repo, which means resolving the git **common** dir, not just finding
//! the nearest `.git`.
//!
//! Layout this has to cope with:
//!
//! ```text
//! main checkout      ~/code/app/.git/                        (a directory)
//! linked worktree    ~/code/app-fix/.git                     (a FILE: "gitdir: …")
//!                 -> ~/code/app/.git/worktrees/app-fix/      (its own git dir)
//!                 -> ~/code/app/.git/worktrees/app-fix/commondir -> "../.."
//! ```
//!
//! Both resolve to the same `repo_key` (`~/code/app/.git`), which is what makes
//! them group together.

use std::path::{Path, PathBuf};

/// Where a session's cwd sits in git terms. Computed once per session (a cwd
/// never changes); the branch is read separately because it does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepoInfo {
    /// Canonicalized git *common* dir — identical for a repo and every one of
    /// its linked worktrees, so it is the grouping key.
    pub repo_key: String,
    /// Display name of the repo (the main working copy's directory name).
    pub repo_name: String,
    /// Display name of this particular checkout. Equals `repo_name` for the
    /// main working copy.
    pub checkout_name: String,
    pub is_linked_worktree: bool,
    /// This checkout's own git dir — `<repo>/.git` for the main copy,
    /// `<repo>/.git/worktrees/<name>` for a linked worktree. HEAD lives here,
    /// so a worktree reports its own branch rather than the main copy's.
    pub git_dir: PathBuf,
}

/// Resolve repo identity for `cwd`, or `None` when it isn't in a git repo (or
/// no longer exists on disk — the common case for a past session whose worktree
/// was deleted, where callers fall back to grouping by cwd).
pub fn discover(cwd: &Path) -> Option<RepoInfo> {
    let start = cwd.canonicalize().ok()?;
    let (dot_git, checkout_root) = find_dot_git(&start)?;
    let git_dir = resolve_git_dir(&dot_git)?;
    let common_dir = resolve_common_dir(&git_dir);

    let repo_key_path = common_dir.canonicalize().unwrap_or(common_dir.clone());
    let git_dir = git_dir.canonicalize().unwrap_or(git_dir);
    let is_linked_worktree = git_dir != repo_key_path;

    // The common dir is normally `<main-worktree>/.git`, so its parent names
    // the repo. A bare repo (`repo.git/`) has no parent working copy — name it
    // after the git dir itself.
    let repo_name = repo_key_path
        .file_name()
        .filter(|n| *n == ".git")
        .and_then(|_| repo_key_path.parent())
        .and_then(base_name)
        .or_else(|| base_name(&repo_key_path))?;
    let checkout_name = base_name(&checkout_root).unwrap_or_else(|| repo_name.clone());

    Some(RepoInfo {
        repo_key: repo_key_path.to_string_lossy().into_owned(),
        repo_name,
        checkout_name,
        is_linked_worktree,
        git_dir,
    })
}

/// Current branch from `<git_dir>/HEAD`.
///
/// `None` for a detached HEAD, and for reftable repos (whose HEAD carries no
/// plain `ref:` line) — showing nothing beats showing something stale. Cheap
/// enough to call on every poll: HEAD is ~41 bytes and always page-cached.
pub fn head_branch(git_dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let name = text
        .trim()
        .strip_prefix("ref:")?
        .trim()
        .strip_prefix("refs/heads/")?;
    (!name.is_empty()).then(|| name.to_string())
}

/// Nearest ancestor containing a `.git` entry. Returns `(the .git path, the
/// checkout root that holds it)`.
fn find_dot_git(start: &Path) -> Option<(PathBuf, PathBuf)> {
    let mut dir = start;
    loop {
        let candidate = dir.join(".git");
        if candidate.exists() {
            return Some((candidate, dir.to_path_buf()));
        }
        dir = dir.parent()?;
    }
}

/// A normal checkout's `.git` is a directory. A linked worktree's is a file
/// containing `gitdir: <path>` pointing at `<repo>/.git/worktrees/<name>`.
fn resolve_git_dir(dot_git: &Path) -> Option<PathBuf> {
    if dot_git.is_dir() {
        return Some(dot_git.to_path_buf());
    }
    let text = std::fs::read_to_string(dot_git).ok()?;
    let raw = text.trim().strip_prefix("gitdir:")?.trim();
    if raw.is_empty() {
        return None;
    }
    Some(absolutize(raw, dot_git.parent()?))
}

/// A linked worktree's git dir carries a `commondir` pointer back to the shared
/// `<repo>/.git`. Absent for a normal checkout, which is its own common dir.
fn resolve_common_dir(git_dir: &Path) -> PathBuf {
    match std::fs::read_to_string(git_dir.join("commondir")) {
        Ok(text) if !text.trim().is_empty() => absolutize(text.trim(), git_dir),
        _ => git_dir.to_path_buf(),
    }
}

fn absolutize(raw: &str, base: &Path) -> PathBuf {
    let p = Path::new(raw);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        // Lexical normalization matters here: `commondir` is usually "../..",
        // and callers derive `repo_name` from `.parent()`. canonicalize() runs
        // afterwards and would fix this, but only when the path still exists.
        normalize(&base.join(p))
    }
}

/// Collapse `.` and `..` lexically. Not symlink-aware — `canonicalize` handles
/// that when the path exists; this only has to keep the fallback key sane.
fn normalize(p: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn base_name(p: &Path) -> Option<String> {
    p.file_name().map(|n| n.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// Unique scratch dir per test — no tempfile dependency.
    fn scratch(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "cv-git-{}-{}-{}-{tag}",
            std::process::id(),
            n,
            tag.len()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A main checkout: `<root>/app/.git/` as a real directory.
    fn make_repo(root: &Path, name: &str, branch: &str) -> PathBuf {
        let work = root.join(name);
        let git = work.join(".git");
        fs::create_dir_all(&git).unwrap();
        fs::write(git.join("HEAD"), format!("ref: refs/heads/{branch}\n")).unwrap();
        work
    }

    /// A linked worktree, exactly as `git worktree add` lays it out.
    fn make_worktree(root: &Path, repo: &Path, name: &str, branch: &str) -> PathBuf {
        let wt = root.join(name);
        fs::create_dir_all(&wt).unwrap();
        let wt_git = repo.join(".git").join("worktrees").join(name);
        fs::create_dir_all(&wt_git).unwrap();
        fs::write(wt_git.join("HEAD"), format!("ref: refs/heads/{branch}\n")).unwrap();
        // git writes this relative, which is exactly the case `absolutize` and
        // `normalize` exist for.
        fs::write(wt_git.join("commondir"), "../..\n").unwrap();
        fs::write(
            wt.join(".git"),
            format!("gitdir: {}\n", wt_git.to_string_lossy()),
        )
        .unwrap();
        wt
    }

    #[test]
    fn plain_checkout_is_its_own_repo() {
        let root = scratch("plain");
        let work = make_repo(&root, "app", "main");
        let info = discover(&work).expect("should discover");
        assert_eq!(info.repo_name, "app");
        assert_eq!(info.checkout_name, "app");
        assert!(!info.is_linked_worktree);
        assert_eq!(head_branch(&info.git_dir).as_deref(), Some("main"));
    }

    #[test]
    fn nested_subdirectory_resolves_to_the_repo_root() {
        let root = scratch("nested");
        let work = make_repo(&root, "app", "main");
        let deep = work.join("src").join("inner");
        fs::create_dir_all(&deep).unwrap();
        let from_deep = discover(&deep).unwrap();
        let from_root = discover(&work).unwrap();
        assert_eq!(from_deep.repo_key, from_root.repo_key);
        assert_eq!(from_deep.checkout_name, "app");
    }

    /// The whole point of item 6: a repo and its worktrees share a group key.
    #[test]
    fn worktree_shares_repo_key_but_keeps_its_own_branch() {
        let root = scratch("wt");
        let work = make_repo(&root, "app", "main");
        let wt = make_worktree(&root, &work, "app-fix", "fix/thing");

        let main = discover(&work).unwrap();
        let linked = discover(&wt).unwrap();

        assert_eq!(main.repo_key, linked.repo_key, "must group together");
        assert_eq!(linked.repo_name, "app");
        assert_eq!(linked.checkout_name, "app-fix");
        assert!(linked.is_linked_worktree);
        assert!(!main.is_linked_worktree);
        assert_eq!(head_branch(&linked.git_dir).as_deref(), Some("fix/thing"));
        assert_eq!(head_branch(&main.git_dir).as_deref(), Some("main"));
    }

    #[test]
    fn detached_and_reftable_heads_report_no_branch() {
        let root = scratch("detached");
        let work = make_repo(&root, "app", "main");
        let git = work.join(".git");
        // Detached HEAD: a raw sha, no `ref:` line.
        fs::write(
            git.join("HEAD"),
            "9f1c0de5b0a1c2d3e4f5061728394a5b6c7d8e9f\n",
        )
        .unwrap();
        assert_eq!(head_branch(&git), None);
        // A tag ref is not a branch.
        fs::write(git.join("HEAD"), "ref: refs/tags/v1.0\n").unwrap();
        assert_eq!(head_branch(&git), None);
    }

    #[test]
    fn missing_directory_yields_none_so_callers_fall_back_to_cwd() {
        let root = scratch("gone");
        let gone = root.join("deleted-worktree");
        assert_eq!(discover(&gone), None);
    }

    #[test]
    fn non_repo_directory_yields_none() {
        let root = scratch("norepo");
        let plain = root.join("just-a-dir");
        fs::create_dir_all(&plain).unwrap();
        // /tmp itself has no .git, so the upward walk terminates at the root.
        assert_eq!(discover(&plain), None);
    }

    #[test]
    fn normalize_collapses_parent_components() {
        assert_eq!(
            normalize(Path::new("/a/b/.git/worktrees/x/../..")),
            PathBuf::from("/a/b/.git")
        );
        assert_eq!(normalize(Path::new("/a/./b")), PathBuf::from("/a/b"));
    }
}
