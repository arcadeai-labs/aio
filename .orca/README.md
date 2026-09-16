# Orca orchestration for this repo

Agent orchestration lives here: a **driver** walks an issue DAG and dispatches
**implementers** and **reviewers** into isolated worktrees. The prompts are the
contract between those roles.

```
.orca/
  README.md          ← you are here
  driver.md          role, limits, protocol, escalation policy
  implementer.md     worker prompt: build one slice
  reviewer.md        worker prompt: verify one PR, fresh worktree
  env.example.md     template for the machine-specific bindings
  local/             GITIGNORED — never committed
    env.md             filled-in copy of env.example.md
    human/             for the operator: gate briefs, decisions, sittings
    state/             for the next driver: DAG.md, DRIVER-STATE.md, HANDOFF.md
```

## The split, and why it is where it is

Everything in `.orca/` except `local/` is committed and public-safe: it
describes roles and rules, not this machine and not one person's run.

`local/` holds the three things that must not be:

- **`env.md`** — the Orca repo id, the Run id, absolute worktree paths. Not
  secret, but meaningless to anyone who forks this, and it changes whenever the
  Run is recreated.
- **`human/`** — what the driver writes *for you*: a gate brief, a decision to
  make, the commands to verify a merged slice. Named `<issue>-<topic>.md`.
  These accumulate fast and are throwaway.
- **`state/`** — what a driver writes for *the next driver* after a compaction
  or a wipe: `DAG.md`, `DRIVER-STATE.md`, `STATUS.md`, `HANDOFF.md`.

**`env.md` sits at the root of `local/`, not inside `state/`, on purpose.** The
driver prompt says state is never authoritative — re-derive the DAG and round
counts from `orca` and `gh` every wave. The repo id and Run id are the one
exception: they are authoritative and cannot be re-derived. Filing them under
`state/` would put them under a rule that would make a driver throw them away.

## Setup

1. Copy `env.example.md` to `local/env.md` and fill it in.
2. In the Orca app, under Repo settings → hooks:
   - setup script: `bash scripts/orca-setup.sh`
   - archive script: `bash scripts/orca-archive.sh`
   - setup policy: **wait-for-setup**, not start-immediately.
3. Create the directories the driver writes into:

   ```sh
   mkdir -p .orca/local/human .orca/local/state
   ```

The setup hook gives each worktree its own port block *and* its own
`COMPOSE_PROJECT_NAME`. The second matters more than the first: Compose derives
volume names from the project name, so two worktrees without it share one
Postgres volume while believing they are isolated. See the comments in
`scripts/orca-setup.sh`.
