import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { ExtensionProvider } from '../src/hooks/useExtension';
import { useXhsScraper } from '../src/hooks/useXhsScraper';
import { DEFAULT_SEARCH_FILTERS } from '../types';

const Probe = () => {
  const { startScraping } = useXhsScraper();
  const [message, setMessage] = React.useState('');

  return (
    <div>
      <button
        onClick={async () => {
          const result = await startScraping('测试关键词', 10, DEFAULT_SEARCH_FILTERS);
          setMessage(`${result.code}:${result.message}`);
        }}
      >
        start
      </button>
      <div data-testid="scrape-message">{message}</div>
    </div>
  );
};

describe('useXhsScraper', () => {
  it('returns a structured error when the extension is unavailable', async () => {
    render(
      <ExtensionProvider>
        <Probe />
      </ExtensionProvider>,
    );

    fireEvent.click(screen.getByText('start'));

    await waitFor(() => {
      expect(screen.getByTestId('scrape-message').textContent).toContain('extension_unavailable');
    });
  });
});
