# Changes

## Conversation validation repair 3 — 2026-11-05

After all185 main cases and the actual30min soak finished, fix the seven observed Router failure roots: expose fresh adjustment state/targets; distinguish identity from resume authority; preserve reply-bound partial-export changes and progress-only queries; clarify unbound media intent; reject unnecessary confirmation for explicit cancellation with retained records; return bounded exact already-read ID hints for a mistyped UUID without fuzzy execution. Keep semantic decisions in the Router and ask it to correct rejected actions in-turn. Refresh Router protocol7 while retaining Worker sessions and permissions.

Seven new regressions observed RED-to-GREEN, one positive authority/neighbor test and protocol-only rotation RED-to-GREEN; full260/260 Windows checks pass. Round3 main179/185pass, native extras4/5pass; the full1800128ms soak fails cancellation retention despite heartbeat, idle polling and same-file continuation passing. Fix3 native effectiveness is not yet claimed: final173 + cumulative failed expressions/cards + a fresh30min soak remain. Production unchanged.

## Round 3 main collection and offline timing — 2026-11-05

Resume the user-paused run on the identical product/catalog hash, preserve completed evidence and retry interrupted fixtures in new directories. All 185 main executions collected: 179 pass / 6 fail / 0 blocked. All 18 real Worker/file cases pass; native coordination failures remain. Recovery12, seeded200 states/input retention, scale20/100/500 and actual33-decision rotation pass; adjustment-card native supplement fails; the fresh continuous30min soak is still running. No product fix or deployment before the entire round ends.

Add offline evidence timing for accepted control receipts, exact-owner-linked real Worker acceptance and accepted Router text at the simulated transport boundary. Reject unavailable/ambiguous measurements rather than infer success. Four observed RED-to-GREEN analyzer regressions and full252/252 Windows checks pass. These are test/report tools, not production logic changes.

## Conversation validation repair 2 — 2026-11-05

After collecting the entire second round, fix recent single-task grounding without overriding a conflicting named task; recognize complementary pause scope without globally pausing the exception; reject stop/pause mismatches; search whitespace-separated terms; require a bounded owner-input tail read before deciding truncated messages. Validate settings shape synchronously so the Router can correct malformed per-worker parameters, and require displayName for nicknames. Retain actual recent control targets for reversal, close target-aligned adjusted questions, and strengthen existing-responsibility reuse instructions.

Carry received attachment metadata from intake to selected task input and stage validated hash-matching copies inside that task workspace; originals remain unchanged. Carry structured media error facts and reject a fabricated voice-recognition explanation for oversized documents. No model changes, new dependencies, production task writes or deployment.

Verification: 13 observed failing deterministic regressions became green; full Windows suite 248/248 passed. Third-round native validation and the real-clock soak are next. Soak timing starts after connection and requires continuous heartbeats; no accelerated clock substitutes for 30 minutes.

## Round 2 collected — 2026-11-05

Complete coverage: 185 executions, 168 pass / 17 fail / 0 blocked; 12 deterministic recovery timelines pass, four native cache/card supplements pass and adjustment-question cleanup fails. Reuse 94 identical post-repair verification executions with explicit provenance and matching product/catalog hashes; complete the other 91 on the same product version. Phase-specific expressions are not inherited. A tested aggregator rejects missing/duplicate attempts and retains raw failure evidence. Full Windows suite: 235/235 passed after a preserved isolated test-process anomaly and limited-concurrency recheck. Product repair 2 has not started at this checkpoint; see `docs/validation/round-2.md`.

## Validation supplements — 2026-11-05

Add synthetic recovery timelines, native cache/card probes, 20/100/500-task recall and actual 33-decision rotation probes, seeded state transitions, and a real-clock 30-minute soak script for subsequent rounds. The soak and scale probes are prepared, not yet executed at this commit. Correct the evidence oracle so a sibling task's running clause does not falsely indict a paused task; retain original native results and separate any regrading.

Verification: 234/234 automated Windows checks and all 12 synthetic recovery helper checks passed. Added a tested metrics summary that separates native and deterministic results, recovered tool errors, available usage snapshots and scenario latency. Product code remains frozen at repair 1 while its native replay continues. Simulated Telegram response loss may duplicate an unacknowledged message; checks prove acknowledged parts are checkpointed and tasks are not re-executed, not exactly-once Telegram delivery.

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
