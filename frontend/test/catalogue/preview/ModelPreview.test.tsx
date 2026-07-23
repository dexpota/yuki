import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelPreview } from '../../../src/catalogue/preview/index.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ModelPreview', () => {
  it('shows explicit non-ready states', () => {
    const { rerender } = render(<ModelPreview preview={{ status: 'processing' }} />);
    expect(screen.getByText('Generating preview…')).toBeInTheDocument();
    rerender(<ModelPreview preview={{ status: 'unsupported', message: 'STEP unavailable' }} />);
    expect(screen.getByText('Preview unavailable: STEP unavailable')).toBeInTheDocument();
    rerender(<ModelPreview preview={{ status: 'failed', message: 'Malformed file' }} />);
    expect(screen.getByText('Preview failed: Malformed file')).toBeInTheDocument();
  });

  it('loads a bounded read-only G-code layer preview', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          version: 1,
          unit: 'mm',
          layers: [
            { z: 0, segments: [[0, 0, 1, 0]] },
            { z: 0.2, segments: [[1, 0, 1, 1]] },
          ],
        }),
      ),
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      beginPath: vi.fn(),
      fillRect: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
    } as unknown as CanvasRenderingContext2D);

    render(
      <ModelPreview
        preview={{ status: 'ready', kind: 'toolpath', artifactUrl: '/preview/layers.json' }}
      />,
    );

    expect(await screen.findByRole('slider', { name: 'Layer' })).toHaveValue('1');
    expect(screen.getByText('2 / 2 · Z 0.20 mm')).toBeInTheDocument();
  });
});
