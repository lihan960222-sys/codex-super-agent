# Changes

## 0.1.1 — 2026-11-05

Fix cancellation of paused/queued tasks selecting another task or silently doing nothing:

- Prefer referenced and unfinished tasks in bounded Router cards. Include actual sent replies and owner commands across native session rotation.
- Ground implicit control in a sent-message reference, explicit task title, bound reply or structured clarification. Reject conflicting references and task-specific references used for global control.
- Require concrete options for control questions and reject plans outside the confirmed options. Refuse cancellation of completed/failed tasks; direct replies remain accepted for status routing.
- Emit named cancellation receipts and retain their references. Remove misleading waiting text for stopped/completed tasks.
- Establish source commits, clean-tree deployment and per-release commit/hash metadata. No credentials, production database or personal style files are published.

Verification: 200 automated Windows tests passed. An isolated native `gpt-6-luna / medium` probe passed three Chinese cancellation/confirmation cases, including session rotation. The host rejected malformed model actions during the probe; the model recovered and changed only the intended task. The probe used fake Telegram transport and never launched Workers.

## Baseline — 2026-11-05

Imported the running `superagent-presentation-20261105-110644-26d7819d` source and its existing regression tests. No runtime state, credentials or personal conversations are included. Earlier development history is not reconstructed; this is the first auditable source snapshot.
