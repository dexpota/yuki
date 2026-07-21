type MetricLabels = Readonly<Record<string, string>>;

interface CounterDefinition {
  readonly help: string;
  readonly allowedLabels: Readonly<Record<string, ReadonlySet<string>>>;
  readonly series: Map<string, { readonly labels: MetricLabels; value: number }>;
}

export interface Counter {
  increment(labels?: MetricLabels, amount?: number): void;
}

export class MetricsRegistry {
  readonly #counters = new Map<string, CounterDefinition>();

  counter(
    name: string,
    help: string,
    allowedLabels: Readonly<Record<string, readonly string[]>> = {},
  ): Counter {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`invalid metric name: ${name}`);
    if (this.#counters.has(name)) throw new Error(`metric already registered: ${name}`);
    const definition: CounterDefinition = {
      help,
      allowedLabels: Object.fromEntries(
        Object.entries(allowedLabels).map(([label, values]) => [label, new Set(values)]),
      ),
      series: new Map(),
    };
    this.#counters.set(name, definition);

    return {
      increment: (labels = {}, amount = 1) => {
        if (!Number.isFinite(amount) || amount < 0) {
          throw new Error('counter amount must be non-negative');
        }
        validateLabels(name, definition.allowedLabels, labels);
        const key = Object.entries(labels)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([label, value]) => `${label}=${value}`)
          .join(',');
        const current = definition.series.get(key);
        definition.series.set(key, { labels, value: (current?.value ?? 0) + amount });
      },
    };
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    for (const [name, definition] of [...this.#counters].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      lines.push(`# HELP ${name} ${definition.help}`, `# TYPE ${name} counter`);
      for (const { labels, value } of definition.series.values()) {
        const renderedLabels = Object.entries(labels)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([label, labelValue]) => `${label}="${escapeLabel(labelValue)}"`)
          .join(',');
        lines.push(`${name}${renderedLabels.length === 0 ? '' : `{${renderedLabels}}`} ${value}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }
}

function validateLabels(
  metric: string,
  allowed: Readonly<Record<string, ReadonlySet<string>>>,
  labels: MetricLabels,
): void {
  if (Object.keys(labels).length !== Object.keys(allowed).length) {
    throw new Error(`metric ${metric} requires exactly: ${Object.keys(allowed).join(', ')}`);
  }
  for (const [label, value] of Object.entries(labels)) {
    if (!allowed[label]?.has(value)) {
      throw new Error(`metric ${metric} rejects label ${label}=${value}`);
    }
  }
}

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}
