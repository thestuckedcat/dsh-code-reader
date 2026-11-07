# Capability-event fixtures (rec-agent)

Optional read-only fixtures for the CL-006 invalidation suite
(`engine/tests/test_invalidation.py`).

- `*.json` are valid `CapabilityEventV1` documents per
  `../../../../schemas/capability-event.schema.json` and
  `docs/implementation-contract.md` §8. Tests load them through
  `support.load_event(name, ...)` and override only `event_id`, `generation`,
  `affected_refs` and `outcome` so each case stays explicit.
- `support.py` holds the shared synthetic workspace-registration/oracle
  helpers for both `test_records.py` and `test_invalidation.py`. It uses only
  the shared `state`/`util` primitives (no `code_learning.workspace`), so the
  record layer can be unit-tested while `workspace.py` is written in parallel.

These are fixtures, not runtime data. The engine never reads this directory at
runtime; `consume_event` only accepts events parsed from the trusted inbox.
