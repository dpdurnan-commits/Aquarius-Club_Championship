/**
 * Application root (task 15.1).
 *
 * Wraps the {@link AppShell} in the {@link RouterProvider} so client-side
 * routing across Course Setup, Competition Setup, Score Entry, and
 * Viewing_Display is available throughout the tree. The typed REST API client
 * lives in `./api/client` and is used by the individual screens (tasks 16–18).
 * (Requirement 7.9)
 */

import { AppShell } from './AppShell.js';
import { RouterProvider } from './routing/router.js';

export function App(): JSX.Element {
  return (
    <RouterProvider>
      <AppShell />
    </RouterProvider>
  );
}
