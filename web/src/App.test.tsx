import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from './App.js';

describe('App shell', () => {
  it('renders the application title', () => {
    render(<App />);
    expect(
      screen.getByRole('heading', { name: /club championship scoring/i }),
    ).toBeInTheDocument();
  });
});
