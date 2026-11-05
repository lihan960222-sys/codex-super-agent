# Changes

## Conversation validation repair 1 — 2026-11-05

After the complete first round (125 pass / 60 fail / 0 blocked across 185 accepted results), fix the reproduced routing/control/continuation failures in one batch: independent multi-create, selected atomic pause/start/stop, scoped resume requirements, concrete short names, semantic handling of bound controls/new tasks, missing Router rollout recovery, queue/wait facts, terminal media/command errors, reply-bound approvals, and send-time state recheck. Ambiguous control uses canonical task/action cards with one-use Confirm/Adjust/Cancel and version guards.

Persist explicit owner style updates without replacing existing preferences; cache file metadata/content version and place stable style in Router base instructions, rotating only Router when changed. Explicit hard style limits are checked locally before acceptance; normal replies require no separate style-review model call. This is no guarantee of native prompt-cache hits or subjective tone perfection.

Verification: 230/230 automated Windows checks passed. Native failed-case/neighbor replay and later full rounds remain pending at this commit. Production unchanged; raw evidence and preference history stay private.

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
# Conversation validation in progress (2026-11-05)

- Corrected validation-only defects found during the first round: continuation must execute on the original thread, interrupted fixture databases cannot be reused, resumed Worker telemetry retains its role, audio proof accepts actual nonempty transcription, and album fixtures contain two distinct images. Preserved original results and scheduled affected cases for replay; no production logic changed.
- Harness verification after correction: 209 tests passed. Original H03 passes were regraded as failures because new sessions had edited the old files.

- Added a frozen catalog of 120 synthetic conversations, 5 continuous stories and 12 new expressions per round; pinned Router gpt-6-luna/medium and Worker gpt-6.1-sol/medium.
- Added isolated Runtime replay, actual model/RPC evidence, file hashes, captured Telegram uploads, bounded cases and deterministic fault checks. No second production Telegram receiver is started.
- Baseline: existing 200 tests passed on Windows. Harness: 7 checks passed; 4 isolated native smoke cases passed, including an actual Worker file write. These are not full-round or phone transport acceptance.
- No production code or deployment changes in this preparation commit. Raw evidence stays in ignored local/.
