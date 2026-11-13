# Migrate to reviewed metadata maintenance

Use this procedure to import normalized entries and replace the old backfill writer with draft, approval, and conditional-apply operations. Keep the old backfill source runnable until its authorized owner drains or stops the old process. This change does not stop, delete, install, or replace a running writer.

## Prepare a temporary target

1. Use Node 24 with `node:sqlite`.
2. Set absolute paths for the plugin and a new temporary workspace. Keep development commands away from the live Alma database.

```bash
PLUGIN=/absolute/path/to/alma-meme-watcher
WORK=$(mktemp -d)
DB="$WORK/meme_radar.db"
INPUT=/absolute/path/to/normalized-entries.json
```

3. Use an existing temporary fixture database for preview and backfill. To create a fixture from the repository's already-normalized seeds, use the explicit create operation.

```bash
node "$PLUGIN/scripts/maintenance.mjs" import-apply --input "$PLUGIN/data/seed-memes.json" --db "$DB" --create
```

4. For backfill, choose a temporary fixture that already has empty `usage_context` or `avoid_when`. Complete seed cards need no backfill. Do not clear a filled field merely to force generation.
5. Inspect the fixture with an explicit database path.

```bash
node "$PLUGIN/scripts/maintenance.mjs" inspect --db "$DB" --fields usage_context,avoid_when --limit 50
```

If you use readonly `inspect` without `--db`, pass the Alma configuration root to `--alma-home`. That root contains `state/meme_radar.db`; it is not the operating-system home directory. Keep using a temporary `--db` during development. All database writes require an explicit `--db`, regardless of the default Alma location.

## Validate and import normalized entries

1. Supply a JSON array with the existing nine fields: `term`, `aliases`, `meaning`, `usage_context`, `avoid_when`, `origin`, `source_url`, `ttl_days`, and `confidence`. Use the existing optional `published_at` format if needed.
2. Provide nonempty `term`, `meaning`, `usage_context`, and `avoid_when`. Keep `source_url` within the existing compiler's supported Bilibili video URL rules.
3. Preview the input. Preview validates entries without writing vocabulary or refreshing TTL. It does not predict alias-merge outcomes.

```bash
node "$PLUGIN/scripts/maintenance.mjs" import-preview --input "$INPUT" --db "$DB" --out "$WORK/import-preview.json"
```

4. Inspect the normalized entries in the preview file.
5. Apply the input to the explicit target.

```bash
node "$PLUGIN/scripts/maintenance.mjs" import-apply --input "$INPUT" --db "$DB"
```

If the database does not exist, use `--create` only for an intentional create/import operation. Existing corrupt or invalid databases remain faults even with `--create`. Import uses the original alias merging, fingerprint replay, and sync transaction implementation. A new import version can refresh TTL and review/source state, so do not use import for metadata-only maintenance.

## Generate pending drafts

1. Obtain `MEME_MAINTENANCE_ENDPOINT` and `MEME_MAINTENANCE_TOKEN` from your runtime configuration. Do not put credentials in source code, report files, or command arguments.
2. Configure a complete OpenAI-compatible chat-completions endpoint. Use HTTPS or loopback HTTP. The client does not follow redirects.
3. Keep the default model `opencode-go/deepseek-v4.1-flash`, or override it with `MEME_MAINTENANCE_MODEL` or `--model`. This workflow does not change model providers.
4. Generate drafts for empty fields only.

```bash
node "$PLUGIN/scripts/maintenance.mjs" draft --db "$DB" --fields avoid_when --source memewiki_import --limit 50 --out "$WORK/drafts.json" --timeout-ms 20000 --attempts 3 --circuit-failures 3
```

Use `--source` only as a stored source-kind filter. Omit it to select all source kinds. It does not fetch a source database or add a Memewiki adapter.

5. Inspect `patches`, `attempt_failures`, `failures`, `unattempted`, and `circuit` in the saved report. Drafts have `approval: "pending"`. Generation never writes vocabulary.
6. If the circuit opens, fix the fault before starting a new draft run. Successful items reset the consecutive-item failure counter. Authentication and request-configuration faults stop the batch without retries.

Each attempt has a deadline. The default is 20 seconds, with a maximum of 60 seconds. Attempts are limited to five per item. Retry delays are bounded, and the configured circuit threshold is limited to 100 failed items. Both intermediate drafts and attempt failures are checkpointed outside database transactions. Use a new output filename for each run, and do not edit its active report.

## Review and approve selected drafts

1. Read each target's canonical term, stored source, meaning, review state, and expected metadata.
2. Check whether the proposed value fits that term, relationship, and emotional context. Reject invented origins, unsupported factual claims, or generic advice that misses the term's risks.
3. If you edit a proposed value, keep the target and its digest unchanged. Keep the value between 8 and 600 characters. The approval command validates the edited value again.
4. Leave unwanted proposals pending, or mark their draft approval as rejected. The approval command refuses explicitly rejected drafts.
5. Select the IDs that you actually approve. Save approval to a separate file.

```bash
node "$PLUGIN/scripts/maintenance.mjs" approve --draft-file "$WORK/drafts.json" --ids "<reviewed-record-id>" --out "$WORK/approved.json"
```

For several records, pass their comma-separated IDs. Split approvals larger than 1000 records into separate files. After approval, keep that file unchanged. This command is an explicit operator-controlled file gate. It does not authenticate a person or turn a receipt string into authorization. Control access to the approval file and the write process. Neither `draft` nor `approve` applies values to the database.

## Apply approved metadata conditionally

1. Apply the approved file to the explicit target.

```bash
node "$PLUGIN/scripts/maintenance.mjs" patch-apply --approved-file "$WORK/approved.json" --db "$DB"
```

2. Inspect every outcome. `updated` fills the approved empty field. `unchanged` confirms a safe replay. `conflict`, `deleted`, `rejected`, and `failed` leave that item unwritten and include stable reasons.
3. If material changed, obtain a new snapshot and review a new draft. Do not edit an expected snapshot to bypass a conflict. Changes to source, meaning, aliases, review evidence, or other snapshotted material invalidate the earlier approval.
4. If a field is already filled by another writer, preserve it. An exact approved postimage can replay unchanged; a different value is a conflict.
5. If a database transaction fails, retry only after fixing its cause. All writes in that transaction roll back.

Metadata apply does not refresh `last_seen` or TTL. It does not modify source, aliases, heat, review state, or other existing metadata columns. A missing metadata row can be inserted only for an existing term. If all items are refused or unchanged, apply creates no metadata or unrelated watcher tables.

Successful commands write JSON to stdout and exit zero. Item refusals or generation failures keep their JSON report and exit two. Command-level faults write a safe JSON error to stderr and exit two. Error messages omit credentials, raw service payloads, stacks, and input paths.

## Review stored cards separately

1. Create a JSON request array with `term` and `status`. Use `accepted` or `rejected`. Canonical terms and existing aliases are supported.
2. Save a readonly review preview.

```bash
node "$PLUGIN/scripts/maintenance.mjs" review-preview --requests "$WORK/review-requests.json" --db "$DB" --out "$WORK/review-preview.json"
```

3. Review the stored source and complete material snapshot.
4. Approve the selected review IDs in another file.

```bash
node "$PLUGIN/scripts/maintenance.mjs" approve --draft-file "$WORK/review-preview.json" --ids "<reviewed-record-id>" --out "$WORK/review-approved.json"
```

5. Apply the approved review file.

```bash
node "$PLUGIN/scripts/maintenance.mjs" review-apply --approved-file "$WORK/review-approved.json" --db "$DB"
```

Review apply changes only review status, review time, and the process actor marker. It preserves source URLs, terms, metadata, and TTL. Replay does not refresh review time. Accepted review cannot override a rejected canonical or alias identity in either review table. Resolving an explicit rejection requires a separate authorized decision outside this bounded workflow.

## Cut over under the authorized owner

1. Run the local proof before proposing the switch.

```bash
node --test "$PLUGIN/tests/maintenance.test.mjs"
npm --prefix "$PLUGIN" test
git -C "$PLUGIN" diff --check
```

2. Keep the existing backfill source unchanged and runnable while its old process remains active.
3. Have the authorized owner let the in-flight old work finish, drain or stop the old process, and confirm it no longer writes the target. This procedure supplies no stop/delete command.
4. Take a consistent SQLite backup before the actual switch. Use the owner's backup procedure, including WAL state where applicable; do not copy a live database file alone.
5. Have the owner approve code delivery and choose the actual target path. Production merge, installation, model verification, and deployment remain separate gates.
6. Generate fresh drafts against the settled target. Review them separately, save explicit approvals, then conditionally apply the approved file.
7. Inspect refusals and readonly lookup results before scheduling later maintenance. Do not restart the old writer concurrently with new maintenance.
8. If rollback is needed, stop writers through the authorized owner and assess changes since the backup before restoring it. Keep the old source available for an owner-approved fallback. This workflow does not provide automatic database restore or process cutover.

## Stay within this migration's limits

Use `maintenanceCandidates({dbPath,fields,source,limit})` for programmatic readonly snapshots and `applyMaintenancePatches(patches,{dbPath,now})` for approved conditional writes. Keep review preview and `applyMaintenanceReviews` separate.

For strict normalized import, use the added `syncMaintenanceEntries(entries,{dbPath,now,create})` store entry point through the maintenance workflow. This small addition shares the private sync implementation with unchanged `syncEntries`. Its existing-only SQLite open prevents a missing-file race from creating a database. No public SQL callback is added.

Supply a valid database with `terms`, `term_reviews`, and `candidate_reviews`. Use `term` as the sole primary key in each table. The metadata table may be absent. Additional ordinary metadata columns are preserved; generated metadata columns are refused. Missing stored source evidence is a visible fault, not an invented source.

Keep imported inputs within the existing normalized Bilibili compiler domain. No Memewiki adapter or generic URL importer is included. The old `meme_import.py` was unavailable, so old-import equivalence is unverified. Output checks reject truncation, invalid JSON, wrong fields, oversized text, and placeholders; they do not prove semantic correctness. Tests use temporary databases and fake services only. Live-model behavior, Alma installation, and production cutover remain unverified.
