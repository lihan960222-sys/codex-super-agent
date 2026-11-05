# Codex Super Agent maintenance

- This directory is the canonical source repository. Never patch an installed release in place.
- Keep changes small. Reproduce bugs with a failing regression before changing production logic.
- Preserve user configuration, credentials, task records and native threads during upgrades.
- For every iteration, commit source/tests/docs together and describe the reason and verification in CHANGELOG.md.
- Deploy only a clean committed tree. Record the Git commit, previous release and SHA-256 file manifest in the release metadata.
- Never commit credentials, user conversations, SQLite databases, personal preference files or task artifacts. Public examples must use placeholders.
- Never claim production verification from mocks alone. Distinguish unit tests, isolated native probes and actual production checks.
