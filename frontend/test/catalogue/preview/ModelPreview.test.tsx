import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ModelPreview } from '../../../src/catalogue/preview/index.js';

describe('ModelPreview', () => {
  it('shows explicit non-ready states', () => {
    const { rerender } = render(<ModelPreview preview={{ status: 'processing' }} />);
    expect(screen.getByText('Generating preview…')).toBeInTheDocument();
    rerender(<ModelPreview preview={{ status: 'unsupported', message: 'STEP unavailable' }} />);
    expect(screen.getByText('Preview unavailable: STEP unavailable')).toBeInTheDocument();
    rerender(<ModelPreview preview={{ status: 'failed', message: 'Malformed file' }} />);
    expect(screen.getByText('Preview failed: Malformed file')).toBeInTheDocument();
  });
});
