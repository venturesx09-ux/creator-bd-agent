import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { PostgresMailboxRepository } from "./database.js";
import { MailboxService } from "./mailbox-service.js";
import { MailboxSyncScheduler } from "./mailbox-scheduler.js";
import { SecretBox } from "./secret-box.js";
import { FeishuClient } from "./feishu-client.js";
import { FeishuCreatorMatcher } from "./feishu-creator-matcher.js";
import { FeishuProgressTracker } from "./feishu-progress.js";
import { OpenAIEmailAnalysisClient } from "./email-analysis.js";
import { DefaultEmailAnalysisProcessor } from "./email-analysis-processor.js";

async function start(): Promise<void> {
  const config = loadConfig();
  const repository = new PostgresMailboxRepository(config.database);
  await repository.initialize();
  const feishuClient = new FeishuClient({ config: config.feishu });
  const secretBox = new SecretBox(config.mailboxEncryptionKey);
  const analysisClient = new OpenAIEmailAnalysisClient(config.openai);
  const analysisProcessor = new DefaultEmailAnalysisProcessor(
    analysisClient,
    repository,
    secretBox,
    feishuClient
  );
  const feishuProgress = new FeishuProgressTracker();
  const feishuMatcher = new FeishuCreatorMatcher(
    feishuClient,
    repository,
    feishuProgress
  );
  const mailboxService = new MailboxService(
    repository,
    secretBox,
    config.mailboxInitialSyncLimit,
    undefined,
    feishuMatcher,
    analysisProcessor
  );
  const scheduler = new MailboxSyncScheduler(
    mailboxService,
    config.mailboxSyncIntervalMinutes
  );
  scheduler.start();
  void scheduler.run();
  const app = createApp({
    config,
    mailboxService,
    feishuClient,
    feishuProgress,
    feishuIndexRefresher: feishuMatcher
  });
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

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    scheduler.stop();
    console.info(JSON.stringify({ event: "server_stopping", signal }));
    server.close(async (error) => {
      if (error) {
        console.error(
          JSON.stringify({ event: "server_stop_failed", message: error.message })
        );
        process.exitCode = 1;
      }
      await repository.close().catch(() => {
        console.error(
          JSON.stringify({ event: "database_stop_failed", message: "Database error" })
        );
        process.exitCode = 1;
      });
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Startup failed";
  console.error(JSON.stringify({ event: "startup_failed", message }));
  process.exitCode = 1;
});
