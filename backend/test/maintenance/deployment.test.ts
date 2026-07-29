import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('maintenance deployment workflow', () => {
  it('drains writers before dumping and resumes only after packaging succeeds', async () => {
    const script = await readFile(resolve('../deploy/backup.sh'), 'utf8');
    expect(script).toContain('running_services=$(compose ps --status running --services)');
    expect(script.indexOf('compose stop --timeout "$drain_seconds" "$service"')).toBeLessThan(
      script.indexOf('pg_dump'),
    );
    expect(script.indexOf('pg_dump')).toBeLessThan(script.indexOf('maintenance create'));
    expect(script.indexOf('maintenance create')).toBeLessThan(
      script.lastIndexOf('resume_services'),
    );
    expect(script).toContain('compose start "$service"');
  });

  it('requires a clean database and verifies objects before enabling restored writes', async () => {
    const script = await readFile(resolve('../deploy/restore.sh'), 'utf8');
    expect(script).toContain('Restore requires a clean database');
    expect(script.indexOf('maintenance verify')).toBeLessThan(script.indexOf('pg_restore'));
    expect(script.indexOf('pg_restore')).toBeLessThan(script.indexOf('maintenance integrity'));
    expect(script.indexOf('maintenance integrity')).toBeLessThan(
      script.indexOf('compose up --detach api worker proxy'),
    );
  });

  it('does not provide the installation master key to the maintenance container', async () => {
    const compose = await readFile(resolve('../deploy/compose.yaml'), 'utf8');
    const start = compose.indexOf('\n  maintenance:');
    const maintenance = compose.slice(start, compose.indexOf('\n  api:', start));
    expect(maintenance).toContain('YUKI_STORAGE_BACKEND');
    expect(maintenance).not.toContain('YUKI_MASTER_KEY');
  });
});
