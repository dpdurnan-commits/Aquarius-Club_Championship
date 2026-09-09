import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  ROUTES,
  RouterProvider,
  routeById,
  routeIdForPath,
} from './router.js';
import { AppShell } from '../AppShell.js';

describe('routeIdForPath', () => {
  it('maps each defined path to its route id', () => {
    for (const route of ROUTES) {
      expect(routeIdForPath(route.path)).toBe(route.id);
    }
  });

  it('ignores a trailing slash', () => {
    expect(routeIdForPath('/course-setup/')).toBe('course-setup');
  });

  it('falls back to the viewing display for an unknown path', () => {
    expect(routeIdForPath('/does-not-exist')).toBe('viewing-display');
  });
});

describe('routeById', () => {
  it('returns the definition for each route id', () => {
    for (const route of ROUTES) {
      expect(routeById(route.id)).toEqual(route);
    }
  });
});

describe('AppShell navigation', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/');
  });

  it('renders the default (viewing display) screen at "/"', () => {
    render(
      <RouterProvider>
        <AppShell />
      </RouterProvider>,
    );
    expect(
      screen.getByRole('heading', { name: /viewing display/i, level: 2 }),
    ).toBeInTheDocument();
  });

  it('navigates to each area when its nav link is clicked', () => {
    render(
      <RouterProvider>
        <AppShell />
      </RouterProvider>,
    );

    fireEvent.click(screen.getByRole('link', { name: /course setup/i }));
    expect(
      screen.getByRole('heading', { name: /course setup/i, level: 2 }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe('/course-setup');

    fireEvent.click(screen.getByRole('link', { name: /score entry/i }));
    expect(
      screen.getByRole('heading', { name: /score entry/i, level: 2 }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe('/score-entry');
  });

  it('marks the active nav link with aria-current', () => {
    render(
      <RouterProvider>
        <AppShell />
      </RouterProvider>,
    );
    fireEvent.click(
      screen.getByRole('link', { name: /competition setup/i }),
    );
    expect(
      screen.getByRole('link', { name: /competition setup/i }),
    ).toHaveAttribute('aria-current', 'page');
  });
});
