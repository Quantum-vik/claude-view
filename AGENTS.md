# AGENTS.md

Guidance for AI agents working in this repo. See `README.md` for what claude-view is and how to
run it.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `Quantum-vik/claude-view`, driven through the `gh` CLI. See
`docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, using their default label strings. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` plus `docs/adr/` at the repo root, both created lazily by
`/domain-modeling` rather than upfront. See `docs/agents/domain.md`.
