export type ReadinessCheck = () => Promise<void> | void;

export interface HealthSnapshot {
  readonly status: 'ready' | 'not_ready';
  readonly checks: Readonly<Record<string, 'up' | 'down'>>;
}

export class HealthRegistry {
  readonly #checks = new Map<string, ReadinessCheck>();
  #acceptingWork = false;

  constructor(private readonly checkTimeoutMs = 1_000) {}

  addReadinessCheck(name: string, check: ReadinessCheck): void {
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new Error(`invalid readiness check name: ${name}`);
    if (this.#checks.has(name)) throw new Error(`readiness check already registered: ${name}`);
    this.#checks.set(name, check);
  }

  setAcceptingWork(accepting: boolean): void {
    this.#acceptingWork = accepting;
  }

  liveness(): { readonly status: 'alive' } {
    return { status: 'alive' };
  }

  async readiness(): Promise<HealthSnapshot> {
    const checks: Record<string, 'up' | 'down'> = {};
    await Promise.all(
      [...this.#checks].map(async ([name, check]) => {
        try {
          await withinTimeout(check, this.checkTimeoutMs);
          checks[name] = 'up';
        } catch {
          checks[name] = 'down';
        }
      }),
    );
    const ready = this.#acceptingWork && Object.values(checks).every((status) => status === 'up');
    return { status: ready ? 'ready' : 'not_ready', checks };
  }
}

async function withinTimeout(check: ReadinessCheck, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(check),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('readiness check timed out')), timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
