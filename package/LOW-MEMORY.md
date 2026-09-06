# Low-memory operation

Arisa can use swap to keep cold pages out of RAM. Swap occupancy alone does not indicate failure: sustained swap-in/out, memory PSI, disk wait, worker restarts and operation latency are the useful signals. Do not run `swapoff` to clear swap on a constrained host, or increase every Node heap to mask an allocation problem.

## Artifact index

The artifact store uses Node's bundled SQLite support (Node >=22.19) and the chat-scoped `getChatArtifactsDatabaseFile(chatId)` path helper. `getChatArtifactsIndexFile(chatId)` still identifies the legacy JSON file, not the live database. Tools must access artifacts through Arisa IPC, not parse storage files.

- Each operation opens its database, uses a 1 MiB page cache with mmap disabled, then closes it. There is no resident history cache per chat.
- Writes insert one artifact. ID lookups and recent-item queries use indexes; history size does not determine their JS heap consumption.
- `listRecent` accepts integer limits from 0 to 1000; 0 returns no items. Results are read incrementally and rejected if their combined serialized size exceeds 16 MiB; callers can reduce the limit or retrieve individual IDs. Memory still depends on individual record size.
- SQLite serializes writes across processes. FULL synchronous commits and rollback journaling preserve atomic writes without accumulating an unbounded WAL.
- The CLI loads agent, bootstrap, slave and TUI modules only in the branches that need them. The persistent service supervisor does not load the worker's agent dependencies.

### Migration and backups

First access to an uninitialized database streams the legacy JSON array one object at a time into a single transaction. Artifact IDs, scope, all fields and insertion order are preserved. Duplicate IDs, invalid chat identities or malformed/truncated input abort the whole migration. A failed migration leaves the original unchanged and can be retried after repairing the input. Memory scales with the largest individual legacy record, not total history size.

A committed database has schema version 1. Subsequent operations do not read or import the legacy JSON again. The original JSON is retained unchanged as a pre-migration backup, but **does not contain later writes**. Never delete a live database assuming that the legacy file is current.

Back up the SQLite database with SQLite's backup API, or stop all writers and copy it along with any journal files. Preserve artifact files separately. A rollback to an older JSON-only core requires stopping all writers, backing up the database, and streaming `SELECT data FROM artifacts ORDER BY seq` into a new JSON array. Fsync and atomically replace the legacy index only after export succeeds. Do not simply revert the code and resume writes to the old JSON snapshot.

## Task storage

`tasksDatabaseFile` identifies the live global scheduler database (`tasks.sqlite`); `tasksFile` is now only the legacy `tasks.json` migration source. Tools must use task IPC rather than read either file directly.

- Due claims use a partial index for pending/authentication-blocked tasks. ID mutations only load and update the selected row; an idle poll does not parse terminal history or rewrite the queue.
- Claim/read/update occurs in one synchronous `BEGIN IMMEDIATE` transaction, including across processes. Connections close after each operation, with a 1 MiB page cache, mmap disabled, FULL synchronous commits and a 5-second lock timeout. No asynchronous work runs while holding the write lock.
- First access imports the legacy array atomically and records schema version 1. This one-time import still loads the legacy array in memory. Startup recovery and unbounded history listing also remain proportional to history size; they are not the per-second hot path.
- Missing legacy input means a fresh database. Malformed input, duplicate IDs, invalid identities, unsupported schemas and unreadable databases fail explicitly instead of silently becoming an empty queue.
- The legacy file stays unchanged and is never reimported after a successful migration. Routes, auth blocks, retry state and interrupted-execution semantics are preserved. Do not run old JSON-writing workers alongside a migrated scheduler.

Back up using SQLite's backup API or stop all writers before copying the database and any journal. To downgrade, stop all writers and export `SELECT data FROM tasks ORDER BY seq` into a new UTF-8 JSON array, fsync and atomically replace `tasks.json` before starting the old core. The retained legacy JSON does not include subsequent changes and is not a safe downgrade by itself.

## Daemons

Keep external ingress daemons running. Request-driven tools should use `autoStart: false` in both their manifest and runtime registration, start through the shared runtime when invoked, and stop when idle. Otherwise the supervisor will repeatedly restart a daemon that deliberately stopped for inactivity. Do not disable ingress or drop sessions to improve a memory benchmark.

## Verification

Run the test suite serially on 1 GiB hosts:

```sh
node --test --test-concurrency=1
```

`test/artifact-index-memory.test.js` migrates a 100 MiB index and runs 300 subsequent operations in a child with a 48 MiB V8 heap. Migration tests cover UTF-8 chunk boundaries, escaping, corruption, rollback/retry, stable IDs, ordering and concurrent writers in separate processes. `test/cli-memory.test.js` runs the status command with a 24 MiB heap. `test/task-database.test.js` checks atomic migration, corruption, separate-process claims and 200 idle polls under a 32 MiB heap with approximately 60 MB of terminal history; idle polling must not rewrite the database.

After deployment, check a real scheduled tool result, PID continuity, daemon health, `free -h`, `vmstat 1`, and `/proc/pressure/memory`. Short observations cannot establish long-term stability or guarantee that every browser workload fits this host.
