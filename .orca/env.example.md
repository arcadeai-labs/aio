# Orca bindings — template

Copy to `.orca/local/env.md` and fill in. That path is gitignored.

These are the facts a driver cannot re-derive from `orca` or `gh`, which is why
they live in a file rather than in a driver's memory. Everything else — the DAG,
round counts, which worker is alive — **must** be re-derived every wave.

---

## Repo

- GitHub: `<owner>/<repo>`
- Orca repo selector: `--repo id:<uuid>`
  Get it from `orca repo list --json`. Always pass it with `--worktree new-top-level`.

## Run

- Orca Run: `run_<id>`
- Bind with: `orca orchestration run-use --id run_<id> --json`
- If the Run is gone, create a new one and **update this file** — a stale Run id
  is the one error here that looks like a broken Orca rather than a stale note.

## Worker models

- Implementer: `--agent <agent> --model <model> --effort <effort>`
- Reviewer: `--agent <agent> --model <model> --effort <effort>`

Deliberately different agents or models where possible. A reviewer that shares
the implementer's blind spots is a rubber stamp.

## Local paths

- Main worktree: `<absolute path>`

## Account note

If every agent commits through the same GitHub account, GitHub refuses a formal
approval from the PR author. Verdicts are then PR **comments** headed
`**[reviewer]** VERDICT: approve|request_changes`, and no green check will ever
appear. Record here which applies:

- Shared account: `yes | no`
