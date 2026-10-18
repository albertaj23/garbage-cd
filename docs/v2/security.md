# Security and failure model

V2 is a **local, single-user academic tool**. It protects the user's machine from accidents in their own
programs and from drive-by web pages. It is **not** safe to expose to untrusted users or to run
untrusted code on a machine you care about. The Java Security Manager is not an option: it was
deprecated in JDK 17 and is permanently disabled from JDK 24 (JEP 486).

## Threat model

| Threat | In scope | Mitigation | Verified by |
| --- | --- | --- | --- |
| A program loops, allocates without bound, floods output or starts threads | yes | wall-clock timeout, heap cap and `-XX:+ExitOnOutOfMemoryError`, CPU limit (Linux), output caps, process-group kill | `controller.test.ts`, `hardening.test.ts` (infinite loop, allocation bomb, stdout and stderr floods, 20,000-thread bomb, direct-buffer exhaustion, stack overflow) |
| A program leaves children running | yes | the whole process group is killed on exit, timeout, cancel and controller shutdown | `hardening.test.ts` (`sleep` started and abandoned; busy child at timeout; SIGTERM to the controller) |
| Malformed or huge source, compiler recursion | yes | 64 KiB source cap, 512 KiB body cap, separate analyzer JVM with its own timeout and `-Xmx256m`, 256 MiB analyzer thread stack | `hardening.test.ts` (14,000-deep parentheses, 30,000-term `+` chain) |
| Another website calls the API (CSRF, DNS rebinding) | yes | bind `127.0.0.1` only; reject any `Host` that is not `localhost` or `127.0.0.1` on the controller's port (a Host without a port means port 80 and is rejected); reject a cross-origin `Origin`; require `Content-Type: application/json` on POSTs so browsers must preflight, and never answer a preflight; no `Access-Control-*` headers on any response | `controller.test.ts`, `hardening.test.ts` |
| Injected environment (`JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`, `JDK_JAVA_OPTIONS`, `CLASSPATH`) | yes | children get an allow-list environment: minimal `PATH`, `LANG`, `HOME` = run directory, `TMPDIR`, `JAVA_HOME` | `hardening.test.ts` (the variables are set in the controller and the program sees none of them) |
| Path traversal through run ids or static files | yes | run ids are generated ULIDs; benchmark and run lookups match request values against directory listings or an in-memory map and never concatenate them into paths; static files come from a map built by walking the client build once (no symlinks, no request-derived paths) | `hardening.test.ts`, `benchmarks.test.ts` |
| Leftover processes or temp files; a second controller sweeping the first's runs | yes | run directory per port with mode 0700, startup sweep kills PID-file process groups and deletes stale run directories, a lock file refuses a second live controller on the same directory, 20 runs / 24 h retention, graceful shutdown on SIGINT, SIGTERM and SIGHUP | `hardening.test.ts` |
| Browser-side injection, clickjacking | yes | CSP (`default-src 'self'`, `script-src 'self'`, `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: no-store` on API responses; React escapes all program output | `hardening.test.ts`, manual check that the dashboard runs under the policy |
| Hostile code reading files or using the network | **no, residual risk** | none beyond the optional hardened mode below | – |
| Multi-user isolation, authentication, quotas | **no** | single user by design | – |

## Limits

| Limit | Engine J | Engine C |
| --- | --- | --- |
| Source | 64 KiB | 64 KiB |
| Analysis and compile | 15 s | n/a |
| Execution | 10 s (selectable to 30 s) | 5 s |
| CPU time (`prlimit --cpu`, Linux) | 20 s | 10 s |
| Heap | `-Xms = -Xmx` 64 MiB (16–512), `-Xss1m`, metaspace 64 MiB, code cache 32 MiB | – |
| Address space (`prlimit --as`, Linux) | not set (breaks JVM reservations) | 1 GiB |
| Written file size (`prlimit --fsize`, Linux) | 64 MiB | 128 MiB |
| Open files (`prlimit --nofile`, Linux) | 256 | 64 |
| stdout and stderr kept | 64 KiB each, killed at 1 MiB | same |
| AST nodes / trace events / snapshot objects | 5,000 / – / – | – / 10⁶ events or 64 MiB / 2,000 |
| Concurrent runs | 1 (`409 BUSY`) | 1 |

All values live in `web/server/src/config.ts` and the adapters; the limits that are actually applied are
reported in every result (`limits`, including `prlimit: "applied" | "unsupported-platform"`).

## Failure handling

| Failure | Detected by | Reported as |
| --- | --- | --- |
| Lexer, parser, runtime error in a toy program | runner catches everything | `program_error` + `LEX_ERROR` / `PARSE_ERROR` / `RUNTIME_ERROR` with a statement span |
| javac errors | analyzer | `compile_error` + `COMPILE_ERROR`, with line and column |
| Uncaught Java exception, `System.exit(n)` | launcher `catch (Throwable)` and shutdown hook | `program_error` + `UNCAUGHT_EXCEPTION` (class, top 20 frames) or `PROGRAM_EXIT`; metrics are still written |
| Java heap exhausted | exit code 3 with HotSpot's message (printed on stdout) | `program_error` + `OUT_OF_MEMORY` |
| Timeout, output flood, cancel | controller timer, byte counters, abort signal | `timeout`, `output_limit`, `cancelled`; group SIGKILL |
| Runner or JVM crash | exit signal | `internal_error` + `PROCESS_CRASH`; partial trace kept, `trace.complete = false` |
| Result missing, invalid JSON or schema | controller | `internal_error` + `SCHEMA_VIOLATION` naming the failing path |
| Controller killed mid-run | startup sweep | old runs absent from the API; orphaned process groups killed and directories deleted |

## Platforms

Supported: Linux and WSL2. macOS is best effort: `prlimit` does not exist there, so CPU, file-size,
open-file and address-space limits are **not applied** (timeouts, heap flags and output caps still
are). In particular a Java program can write files at disk speed until its timeout on macOS. Native
Windows is unsupported. The Linux `prlimit` path is implemented but has **not been exercised on a Linux host** in this
repository's test runs, so its effect is untested.

## Residual risks (state these in any report or demo)

- Submitted Java can read any file the user can read (`user.home` comes from the passwd entry, not
  `$HOME`), open network connections and start processes until the timeout.
- `prlimit` applies per process, not per process tree, and the process-group kill does not reach a
  child that creates its own session or group.
- JVM limits do not cover all native memory.
- The controller has no authentication; any local process or user on the machine can call it.
- Output sent to the dashboard is escaped, but a program can print misleading text.

Run the tool inside a VM, WSL instance or disposable container when running other people's code.

## Optional hardened mode (documented, not built)

On Linux, run the JVM under bubblewrap with no network and a read-only filesystem except the run
directory, for example by prefixing the launcher command with:

```sh
bwrap --unshare-net --unshare-pid --die-with-parent \
      --ro-bind / / --tmpfs /home --bind "$RUN_DIR" "$RUN_DIR" --dev /dev --proc /proc \
      --chdir "$RUN_DIR" -- java …
```

or run the whole controller in a container without network access. Both are untested here and are
not enabled because they add a platform dependency that a single user running their own code does not
need.
