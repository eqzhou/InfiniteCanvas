export class LatestWrite<T> {
  private pending: T | undefined;
  private hasPending = false;
  private running: Promise<void> | null = null;
  private lastError: unknown | null = null;

  constructor(
    private readonly write: (value: T) => Promise<void>,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  enqueue(value: T): void {
    this.pending = value;
    this.hasPending = true;
    this.running ??= this.drain();
  }

  async flush(): Promise<void> {
    while (this.running) await this.running;
    if (this.lastError !== null) {
      const error = this.lastError;
      this.lastError = null;
      throw error;
    }
  }

  private async drain(): Promise<void> {
    while (this.hasPending) {
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
