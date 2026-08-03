import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

try {
  const config = loadConfig();
  const app = createApp({ config });
  const server = app.listen(config.port, "0.0.0.0", () => {
    console.info(
      JSON.stringify({
        event: "server_started",
        host: "0.0.0.0",
        port: config.port,
        environment: config.nodeEnv
      })
    );
  });

  const shutdown = (signal: string): void => {
    console.info(JSON.stringify({ event: "server_stopping", signal }));
    server.close((error) => {
      if (error) {
        console.error(
          JSON.stringify({ event: "server_stop_failed", message: error.message })
        );
        process.exitCode = 1;
      }
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
} catch (error) {
  const message = error instanceof Error ? error.message : "Startup failed";
  console.error(JSON.stringify({ event: "startup_failed", message }));
  process.exitCode = 1;
}
