# Migrate community reads to generic meme use

## Preview the source change

Keep the installed Alma skill tree and state read-only during development. Use Node.js 24 and Python 3.12 for the CLI and extracted-function tests.

Run the preview with an explicit source and installed plugin root:

```bash
node scripts/migrate-community.mjs plan --skill-dir "<absolute-community-skill-dir>" --plugin-root "<absolute-installed-plugin-root>"
```

With no operation, the CLI uses `plan`. Planning reads source files without changing the skill or Alma state. To save a plan for review, add `--out "<absolute-plan-file-outside-skill-tree>"`.

When the source lives under `<alma-config-root>/skills`, the default plugin root is `<alma-config-root>/plugins/alma-meme-watcher`. Otherwise the default config root is `homedir()/.config/alma`. `--alma-home` always names the Alma config root. Use `--plugin-root` when the installed plugin has another location. Planning does not assert that the plugin or lookup tool is installed.

Review the plan's `sourceRoot`, `pluginRoot`, `almaHome`, SHA-256 `digest`, and `files`. Each file has a preimage and postimage hash and mode. Changed files also contain base64 preimage and postimage bytes. Unchanged records protect the copied source, including the backfill file. The digest detects plan changes; it is not authentication or approval.

Recognized changes remove only the facade's implicit `data.knowledge` attachment, `_catalog_detail`, its ignored scan call, and the post and floor notes blocks with `_meme_notes`. The explicit `read knowledge --query` route and public protocol validator remain. `PublicKnowledge` receives an absolute installed lookup path instead of a repository checkout path.

When present, the recognized legacy `meme_inject.py` and `meme_radar.py` become explicit public-CLI shims. Supported helper fingerprints cover the installed 2026-11-13 source and the portable test fixtures. Helper drift fails planning rather than discarding unknown code. The shims forward `lookup` and policy `get` or `set`; legacy `tone` and `scale` forward to the same policy CLI. Implicit brief generation, private SQLite reads, and the second policy writer are retired. Imported legacy helper functions are not retained.

Keep `meme_backfill_avoid.py` byte-identical. Sending, account verification, image preparation, layer relationships, receipts, community state, runtime, context, and admin logic retain their original code. Unknown lookup callers, source blocks, and symlinks fail planning.

## Verify a temporary staged copy

Run staging before the installation gate:

```bash
node scripts/migrate-community.mjs stage --skill-dir "<absolute-community-skill-dir>" --plugin-root "<absolute-installed-plugin-root>"
```

The result names a fresh temporary `stageDir` and a saved `planPath` outside that copy. Staging writes only that temporary directory. The saved plan still targets its original `sourceRoot`, not the staged copy. Inspect that root before any later apply.

Run the portable tests:

```bash
node --test tests/policy.test.mjs tests/integration*.test.mjs
npm test
git diff --check
```

To exercise an installed source version without installing changes, set `MEME_INTEGRATION_INSTALLED_SKILL` to its absolute skill directory and run `node --test tests/integration-migration.test.mjs`. The test copies the source into a temporary Alma tree. It exercises stage, temporary apply, replay, and rollback. It compares the installed source hashes before and after. `MEME_INTEGRATION_PYTHON` can select the Python executable.

The portable Python source fixtures are `.py.txt` data. The tests materialize them as `.py` only in temporary skill trees. The Python probe executes the extracted `read_post`, `read_floor`, and facade `_read_detail` bodies with fixed content and fake SDK calls. The unmodified fixture fails with one implicit lookup per path. The staged copy requires zero lookups, no attached knowledge or notes, ordered post text and images, exact floor relationships, account verification, and detail delivery. A second run omits the meme helpers entirely. The explicit knowledge probe executes the public adapter against a synthetic lookup CLI and checks success, no-hit, missing or corrupt database faults, protocol errors, and timeout handling.

Protected-function hashes and whole-file hashes supplement those behavior checks. These tests do not execute a live Alma session or prove that an agent follows natural-language skill instructions.

## Apply only after the installation gate

Obtain the operator's approval for the actual installation and cutover. Use a reviewed saved plan and a durable backup directory outside the skill tree:

```bash
node "<absolute-installed-plugin-root>/scripts/migrate-community.mjs" apply --plan "<absolute-reviewed-plan-file>" --backup-dir "<absolute-backup-dir>"
```

Apply checks every recorded source file before any backup or source write. It backs up all changed preimages and the plan before replacing source files. Canonical migrations use one source lock. A same-plan lock from a proven dead process can be recovered; live or unrecognized locks remain untouched. Retain the backup until the cutover is accepted.

Replay with the same plan and backup returns `already_applied`. A preimage/postimage mixture resumes only with its complete original backup. A drifted file or missing backup produces a fault instead of success. Each replacement is atomic. Filesystem failure or a non-cooperating writer during a multi-file operation can leave a detected partial state; the backup supports reconciliation, not a claim of a cross-file transaction.

To restore this plan's changes, run:

```bash
node "<absolute-installed-plugin-root>/scripts/migrate-community.mjs" rollback --backup-dir "<absolute-backup-dir>"
```

Rollback checks source and backup hashes before restoring anything. It restores only matching postimages, leaves matching preimages alone, and refuses to overwrite foreign edits. Rollback can resume a partial restoration. It retains the backup. A damaged or incomplete backup requires investigation rather than deletion of the current source.

## Complete the fresh Alma-session gate

After the operator installs the plugin and generic skill, start a fresh Alma session and verify the actual discovered `plugin--alma-meme-watcher--meme_watch_lookup` schema and result envelopes. If discovery is absent, verify the absolute installed CLI fallback from an unrelated working directory.

Check optional desktop chat, a community read with the plugin unavailable, an Alma-initiated lookup after unknown community slang, an explicit alias meaning and source question at playfulness 0, serious help with a matching keyword, playfulness 100 without forced jokes, no-hit, database faults, and a user correction without production vocabulary or policy writes. Preserve uncertainty for missing source and usage fields.

These installation and natural-language checks are pending stage one. This stage does not deploy, call a model, change production policy or vocabulary, or implement maintenance.
