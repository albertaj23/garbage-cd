import { startServer } from "./server.js";

void startServer()
  .then((app) => {
    app.log.info("Garbage-CD controller listening on loopback");
    // Runs are detached process groups, so a plain exit would leave them running. Closing the
    // app aborts every active run and waits for its process group to be killed.
    let closing = false;
    const shutdown = (signal: string): void => {
      if (closing) return;
      closing = true;
      app.log.info({ signal }, "Shutting down: stopping active runs");
      const forced = setTimeout(() => process.exit(1), 10_000);
      forced.unref();
      app.close().then(
        () => process.exit(0),
        (error: unknown) => {
          console.error("Shutdown failed:", error);
          process.exit(1);
        }
      );
    };
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.on(signal, () => shutdown(signal));
    }
  })
  .catch((error: unknown) => {
    console.error("Unable to start Garbage-CD controller:", error);
    process.exitCode = 1;
  });
