export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface CorrelationFields {
  readonly requestId?: string;
  readonly jobId?: string;
  readonly operationId?: string;
}

export type LogFields = CorrelationFields & Readonly<Record<string, unknown>>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(fields: CorrelationFields): Logger;
}

export interface JsonLoggerOptions {
  readonly service: string;
  readonly minimumLevel?: LogLevel;
  readonly write?: (line: string) => void;
  readonly now?: () => Date;
}

const levels: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const secretKey =
  /(?:authorization|cookie|credential|password|secret|token|api[-_]?key|signature|signed[-_]?url)/i;
const sensitiveQueryParameter =
  /([?&](?:access_token|api_key|credential|password|secret|signature|token)=)[^&#\s]*/gi;
const bearerCredential = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const urlUserInfo = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;
const redacted = '[REDACTED]';

export function createJsonLogger(options: JsonLoggerOptions): Logger {
  const threshold = levels.indexOf(options.minimumLevel ?? 'info');
  const write = options.write ?? console.info;
  const now = options.now ?? (() => new Date());

  const create = (correlation: CorrelationFields): Logger => {
    const log = (level: LogLevel, event: string, fields: LogFields = {}) => {
      if (levels.indexOf(level) < threshold) return;
      write(
        JSON.stringify({
          ...(sanitize({ ...correlation, ...fields }) as Record<string, unknown>),
          timestamp: now().toISOString(),
          level,
          service: options.service,
          event,
        }),
      );
    };

    return {
      debug: (event, fields) => log('debug', event, fields),
      info: (event, fields) => log('info', event, fields),
      warn: (event, fields) => log('warn', event, fields),
      error: (event, fields) => log('error', event, fields),
      child: (fields) => create({ ...correlation, ...fields }),
    };
  };

  return create({});
}

export function sanitize(value: unknown, key = '', seen = new WeakSet<object>()): unknown {
  if (secretKey.test(key)) return redacted;
  if (typeof value === 'string') {
    return value
      .replace(urlUserInfo, `$1${redacted}@`)
      .replace(sensitiveQueryParameter, `$1${redacted}`)
      .replace(bearerCredential, `$1 ${redacted}`);
  }
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (value instanceof Error) {
    return { name: value.name, message: sanitize(value.message), stack: sanitize(value.stack) };
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item, '', seen));

  return Object.fromEntries(
    Object.entries(value).map(([field, fieldValue]) => [field, sanitize(fieldValue, field, seen)]),
  );
}
