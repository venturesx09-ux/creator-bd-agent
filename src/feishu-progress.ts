export type FeishuIndexProgress = {
  status: "idle" | "loading" | "refreshing" | "ready" | "failed";
  source?: "database" | "feishu";
  loaded: number;
  total?: number;
};

export type FeishuProcessingProgress = {
  status: "idle" | "processing" | "completed" | "completed_with_errors" | "failed";
  startedAt?: string;
  updatedAt: string;
  activeBatches: number;
  index: FeishuIndexProgress;
  messages: {
    total: number;
    processed: number;
    matched: number;
    unmatched: number;
    writebackSucceeded: number;
    failed: number;
  };
  error?: string;
};

const NEW_SESSION_AFTER_MS = 30_000;

export class FeishuProgressTracker {
  private activeBatches = 0;
  private lastCompletedAt = 0;
  private state: FeishuProcessingProgress = this.emptyState();

  snapshot(): FeishuProcessingProgress {
    return structuredClone(this.state);
  }

  beginBatch(total: number): void {
    const shouldReset =
      this.state.status === "idle" ||
      (this.activeBatches === 0 &&
        Date.now() - this.lastCompletedAt > NEW_SESSION_AFTER_MS);
    if (shouldReset) this.state = this.emptyState();
    this.activeBatches += 1;
    this.state.activeBatches = this.activeBatches;
    this.state.status = "processing";
    this.state.startedAt ??= new Date().toISOString();
    this.state.messages.total += total;
    this.touch();
  }

  indexLoading(status: "loading" | "refreshing"): void {
    this.state.index = { status, source: "feishu", loaded: 0 };
    this.touch();
  }

  indexPage(loaded: number, total?: number): void {
    this.state.index = {
      status: this.state.index.status === "refreshing" ? "refreshing" : "loading",
      source: "feishu",
      loaded,
      ...(total !== undefined ? { total } : {})
    };
    this.touch();
  }

  indexReady(loaded: number, source: "database" | "feishu"): void {
    this.state.index = {
      status: "ready",
      source,
      loaded,
      total: loaded
    };
    this.touch();
  }

  indexFailed(): void {
    this.state.index = { ...this.state.index, status: "failed" };
    this.touch();
  }

  messageSucceeded(matched: boolean): void {
    this.state.messages.processed += 1;
    if (matched) {
      this.state.messages.matched += 1;
      this.state.messages.writebackSucceeded += 1;
    } else {
      this.state.messages.unmatched += 1;
    }
    this.touch();
  }

  messageFailed(): void {
    this.state.messages.processed += 1;
    this.state.messages.failed += 1;
    this.touch();
  }

  endBatch(): void {
    this.activeBatches = Math.max(0, this.activeBatches - 1);
    this.state.activeBatches = this.activeBatches;
    if (this.activeBatches === 0) {
      this.lastCompletedAt = Date.now();
      this.state.status = this.state.messages.failed > 0
        ? "completed_with_errors"
        : "completed";
    }
    this.touch();
  }

  failBatch(message: string): void {
    this.activeBatches = Math.max(0, this.activeBatches - 1);
    this.state.activeBatches = this.activeBatches;
    this.state.status = "failed";
    this.state.error = message;
    this.lastCompletedAt = Date.now();
    this.touch();
  }

  private emptyState(): FeishuProcessingProgress {
    return {
      status: "idle",
      updatedAt: new Date().toISOString(),
      activeBatches: 0,
      index: { status: "idle", loaded: 0 },
      messages: {
        total: 0,
        processed: 0,
        matched: 0,
        unmatched: 0,
        writebackSucceeded: 0,
        failed: 0
      }
    };
  }

  private touch(): void {
    this.state.updatedAt = new Date().toISOString();
  }
}
