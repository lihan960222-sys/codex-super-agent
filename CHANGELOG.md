# Changes

## Validation model baseline — 2026-11-05

Pin all three validation rounds and final verification to the user-selected Router `gpt-6-luna / medium` and Worker `gpt-6.1-sol / medium`. Model-switch cases remain isolated exceptions with recorded actual values. Unavailable models block testing instead of silently falling back. Documentation only; production settings unchanged and no tests executed.

## Validation plan — 2026-11-05

Document a three-round, conversation-driven validation process with 120 synthetic scenarios, 24 critical cases repeated three times per round, and five multi-turn stories. Each round freezes the code until its full test results are collected, then groups minimal fixes before the next round; final verification follows the third repair batch. Distinguish simulated transport, native Router inference, real Worker execution and actual Telegram delivery.

Documentation only. Scenario IDs/counts were checked; no new scenario runs, runtime changes or deployment occurred in this planning step. See `docs/superpowers/plans/2026-11-05-conversation-validation.md`.

## Deployment correction — 2026-11-05

Allow an explicit Git executable path when the elevated Windows session has a different PATH. The first deployment attempt stopped before any service or production file changed because Git was unavailable in that session.

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
