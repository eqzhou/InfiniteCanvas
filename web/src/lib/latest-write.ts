export class LatestWrite<T> {
  private pending: T | undefined;
  private hasPending = false;
  private running: Promise<void> | null = null;
  private lastError: unknown | null = null;
  private exactQueued = 0;
  private exactTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly write: (value: T) => Promise<void>,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  enqueue(value: T): void {
    this.pending = value;
    this.hasPending = true;
    if (this.exactQueued === 0) this.running ??= this.drain();
  }

  writeExact(value: T): Promise<void> {
    this.exactQueued += 1;
    const operation = this.exactTail.then(async () => {
      try {
        while (this.running) await this.running;
        await this.write(value);
        this.lastError = null;
      } finally {
        this.exactQueued -= 1;
        if (this.exactQueued === 0 && this.hasPending) this.running ??= this.drain();
      }
    });
    this.exactTail = operation.catch(() => undefined);
    return operation;
  }

  async flush(): Promise<void> {
    await this.exactTail;
    while (this.running) await this.running;
    if (this.lastError !== null) {
      const error = this.lastError;
      this.lastError = null;
      throw error;
    }
  }

  private async drain(): Promise<void> {
    while (this.hasPending && this.exactQueued === 0) {
      const value = this.pending as T;
      this.pending = undefined;
      this.hasPending = false;
      try {
        await this.write(value);
        this.lastError = null;
      } catch (error) {
        this.lastError = error;
        this.onError(error);
      }
    }
    this.running = null;
  }
}
