# arisa-restart

Restarts the active Arisa background service without updating its Git checkout or dependencies.

The tool creates a token-owned job, launches an independent detached worker, verifies the old process by exact command arguments and Linux process start time, signals it, starts Arisa again, and requires repeated successful PID and IPC checks over a stability window. If the verified process does not exit after the graceful SIGTERM timeout, the worker verifies its identity again before escalating to SIGKILL. If the first start does not become stable, it retries only after proving that no old service remains alive.

## Actions

- `preflight`: verify the active service identity.
- `status`: inspect the latest restart job or a selected generated `jobId`.
- `restart`: begin a restart; requires `confirm: true`.

```json
{
  "args": {
    "action": "restart",
    "confirm": true
  }
}
```

This tool intentionally performs no Git operations, package installation, or code update.
