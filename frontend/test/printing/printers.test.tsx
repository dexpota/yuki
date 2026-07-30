import { QueryClient } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppProviders, createTestRouter } from '../../src/shared/app/App.js';

const printer = {
  id: 'printer-1',
  displayName: 'Workshop MK4',
  enabled: true,
  credentialConfigured: true,
  connectionStatus: 'online',
  operationalState: 'operational',
  profile: {
    schemaVersion: 1,
    buildVolume: {
      shape: 'rectangular',
      origin: 'lowerleft',
      widthMm: 250,
      depthMm: 210,
      heightMm: 220,
    },
    compatibility: {
      gcodeFlavors: ['marlin'],
      nozzleDiameterMm: 0.4,
      extruderCount: 1,
    },
  },
  verifiedAt: '2026-07-28T08:00:00.000Z',
  createdAt: '2026-07-28T08:00:00.000Z',
  updatedAt: '2026-07-28T08:00:00.000Z',
  version: 1,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/v1/printing/printers') return Promise.resolve(Response.json([printer]));
      if (path.endsWith('/monitoring'))
        return Promise.resolve(
          Response.json({
            printerId: printer.id,
            freshness: 'stale',
            stale: true,
            lastAttemptAt: '2026-07-28T08:10:00.000Z',
            lastSuccessAt: '2026-07-28T08:09:00.000Z',
            lastFailureAt: '2026-07-28T08:10:00.000Z',
            consecutiveFailures: 1,
            reconciliationState: 'local_job_detected',
            current: {
              id: 'observation-1',
              observedAt: '2026-07-28T08:10:00.000Z',
              reason: 'scheduled',
              online: false,
              operationalState: null,
              activeJob: {
                kind: 'none',
                applicationJobId: null,
                upstreamFileName: null,
                upstreamFilePath: null,
                upstreamFileOrigin: null,
              },
              progressPercent: null,
              elapsedSeconds: null,
              remainingSeconds: null,
              temperatures: [],
              failureKind: 'timeout',
            },
            lastGood: {
              id: 'observation-0',
              observedAt: '2026-07-28T08:09:00.000Z',
              reason: 'scheduled',
              online: true,
              operationalState: 'printing',
              activeJob: {
                kind: 'local',
                applicationJobId: 'queue-1',
                upstreamFileName: 'bracket.gcode',
                upstreamFilePath: null,
                upstreamFileOrigin: null,
              },
              progressPercent: 42,
              elapsedSeconds: 600,
              remainingSeconds: 900,
              temperatures: [{ component: 'tool0', actualCelsius: 210, targetCelsius: 215 }],
              failureKind: null,
            },
          }),
        );
      if (path.endsWith('/queue'))
        return Promise.resolve(
          Response.json({
            entries: [
              {
                id: 'queue-1',
                printerId: printer.id,
                assetId: 'asset-1234567890',
                state: 'queued',
                position: 1,
                compatibilityStatus: 'warning',
                compatibilitySnapshot: {
                  result: {
                    checks: [
                      {
                        rule: 'nozzle_diameter',
                        status: 'warning',
                        code: 'nozzle_unknown',
                        message: 'G-code nozzle diameter is unknown.',
                      },
                    ],
                  },
                },
                overrideJustification: null,
                printAttemptId: null,
                upstreamPath: null,
                error: null,
                createdAt: '2026-07-28T08:00:00.000Z',
                updatedAt: '2026-07-28T08:00:00.000Z',
                version: 1,
              },
            ],
          }),
        );
      if (path.startsWith('/api/v1/catalogue/models?'))
        return Promise.resolve(Response.json({ items: [], nextCursor: null }));
      if (path.endsWith('/start-confirmations'))
        return Promise.resolve(
          Response.json({
            token: 'confirmation-token',
            expiresAt: '2099-07-28T08:20:00.000Z',
            printer: { id: printer.id, name: printer.displayName },
            file: { assetId: 'asset-1', filename: 'bracket.gcode', byteSize: 1_000_000 },
            compatibilityStatus: 'warning',
            warnings: ['Review the unknown nozzle diameter.'],
            safetyNotice: 'Ensure the build plate is clear.',
          }),
        );
      return Promise.resolve(
        Response.json({
          authenticated: true,
          setupRequired: false,
          owner: { id: 'owner-1', username: 'Owner' },
          csrfToken: 'csrf-session',
          expiresAt: '2099-01-01T00:00:00.000Z',
        }),
      );
    }),
  );
});

function renderRoute(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={createTestRouter([path])} />
    </AppProviders>,
  );
}

describe('printer workspace', () => {
  it('lists configured printers without exposing their endpoint or credential', async () => {
    renderRoute('/printers');

    expect(await screen.findByRole('heading', { name: 'Printers' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /Workshop MK4/ })).toHaveAttribute(
      'href',
      '/printers/printer-1',
    );
    expect(screen.queryByText(/API key/i)).not.toBeInTheDocument();
  });

  it('keeps the default printer dimensions valid against their numeric step bases', async () => {
    renderRoute('/printers');
    await screen.findByRole('heading', { name: 'Printers' });
    fireEvent.click(screen.getByRole('button', { name: 'Add printer' }));

    for (const name of [
      'Width / diameter (mm)',
      'Depth (mm)',
      'Height (mm)',
      'Nozzle diameter (mm)',
      'Extruders',
    ]) {
      const input = screen.getByRole('spinbutton', { name }) as HTMLInputElement;
      expect(input.checkValidity()).toBe(true);
    }
  });

  it('marks stale facts, explains compatibility, and requires a start confirmation', async () => {
    renderRoute('/printers/printer-1');

    expect(await screen.findByRole('heading', { name: 'Workshop MK4' })).toBeInTheDocument();
    expect(await screen.findByText(/Live contact is stale/)).toBeInTheDocument();
    expect(screen.getByText('bracket.gcode')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Compatibility details'));
    expect(screen.getByText('G-code nozzle diameter is unknown.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Review & start' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('Ensure the build plate is clear.');
    expect(screen.getByRole('button', { name: 'Confirm action' })).toBeInTheDocument();
  });

  it('keeps saved endpoint and credential masked during configuration', async () => {
    renderRoute('/printers/printer-1');
    await screen.findByRole('heading', { name: 'Workshop MK4' });

    fireEvent.click(screen.getByRole('button', { name: 'Configure' }));
    await waitFor(() =>
      expect(screen.getByPlaceholderText('Saved address remains hidden')).toHaveValue(''),
    );
    expect(screen.getByPlaceholderText('Credential is configured')).toHaveAttribute(
      'type',
      'password',
    );
  });
});
