/**
 * Minimal dependency-free client-side router (task 15.1).
 *
 * The app is a single-page app whose four functional areas — Course Setup,
 * Competition Setup, Score Entry, and Viewing_Display — are selected purely on
 * the client. Rather than pull in a routing library, this module provides just
 * enough: a small typed set of routes, a hook exposing the current route and a
 * `navigate` function backed by the History API, and a `<RouterLink>` that
 * performs in-app navigation without a full page reload. The backend serves
 * `index.html` for any non-`/api` GET (its SPA fallback), so deep links to these
 * paths resolve to the app, which then renders the matching screen. (Requirement
 * 7.9)
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';

/** The four client-side routes, keyed by a stable id used in navigation. */
export type RouteId =
  | 'course-setup'
  | 'competition-setup'
  | 'score-entry'
  | 'viewing-display';

/** Metadata describing a single route: its URL path and nav label. */
export interface RouteDefinition {
  readonly id: RouteId;
  /** The absolute URL path this route lives at. */
  readonly path: string;
  /** The human-readable label shown in the navigation. */
  readonly label: string;
}

/**
 * The route table. Order defines the navigation order. `viewing-display` is the
 * default landing route (mapped from `/`), since the clubhouse display is the
 * most-used surface. (Requirement 7.9)
 */
export const ROUTES: readonly RouteDefinition[] = [
  { id: 'viewing-display', path: '/', label: 'Viewing Display' },
  { id: 'course-setup', path: '/course-setup', label: 'Course Setup' },
  {
    id: 'competition-setup',
    path: '/competition-setup',
    label: 'Competition Setup',
  },
  { id: 'score-entry', path: '/score-entry', label: 'Score Entry' },
] as const;

/** The route used when the current path matches none of the defined routes. */
const FALLBACK_ROUTE_ID: RouteId = 'viewing-display';

/**
 * Resolve a URL path to a {@link RouteId}. Trailing slashes are ignored and an
 * unknown path falls back to the default route so an unmatched deep link still
 * lands somewhere sensible rather than rendering nothing.
 */
export function routeIdForPath(path: string): RouteId {
  const normalized =
    path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const match = ROUTES.find((route) => route.path === normalized);
  return match ? match.id : FALLBACK_ROUTE_ID;
}

/** Look up a route definition by id. */
export function routeById(id: RouteId): RouteDefinition {
  // ROUTES always contains every RouteId, so the find never fails; the throw is
  // unreachable in practice and keeps the return type non-optional for callers.
  const match = ROUTES.find((route) => route.id === id);
  if (match === undefined) {
    throw new Error(`Unknown route id: ${id}`);
  }
  return match;
}

/** The value exposed by the router context to consumers. */
interface RouterContextValue {
  /** The currently active route. */
  readonly current: RouteId;
  /** Navigate to a route by id, pushing a new history entry. */
  readonly navigate: (id: RouteId) => void;
}

const RouterContext = createContext<RouterContextValue | null>(null);

/** The current pathname, guarding against non-browser (test) environments. */
function currentPath(): string {
  return typeof window === 'undefined' ? '/' : window.location.pathname;
}

/**
 * Provides router state to the tree. Tracks the active route from the History
 * API, listens for `popstate` (back/forward), and exposes `navigate` which
 * pushes a new entry and updates state without a page reload.
 */
export function RouterProvider({ children }: { children: ReactNode }): JSX.Element {
  const [current, setCurrent] = useState<RouteId>(() =>
    routeIdForPath(currentPath()),
  );

  useEffect(() => {
    const onPopState = (): void => {
      setCurrent(routeIdForPath(currentPath()));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((id: RouteId): void => {
    const target = routeById(id);
    if (typeof window !== 'undefined' && currentPath() !== target.path) {
      window.history.pushState(null, '', target.path);
    }
    setCurrent(id);
  }, []);

  const value = useMemo<RouterContextValue>(
    () => ({ current, navigate }),
    [current, navigate],
  );

  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

/**
 * Access the router. Must be called within a {@link RouterProvider}; throws
 * otherwise so a misuse surfaces immediately rather than silently no-op-ing.
 */
export function useRouter(): RouterContextValue {
  const value = useContext(RouterContext);
  if (value === null) {
    throw new Error('useRouter must be used within a RouterProvider.');
  }
  return value;
}

/** Props for {@link RouterLink}. */
interface RouterLinkProps {
  /** The route to navigate to when clicked. */
  readonly to: RouteId;
  /** Whether this link represents the active route (for styling/aria). */
  readonly active?: boolean;
  readonly children: ReactNode;
}

/**
 * An anchor that performs in-app navigation. It renders a real `href` (so the
 * link is copyable and works without JS) but intercepts ordinary left-clicks to
 * navigate via the router instead of reloading the page. Modifier-clicks and
 * non-primary buttons fall through to default browser behavior.
 */
export function RouterLink({ to, active, children }: RouterLinkProps): JSX.Element {
  const { navigate } = useRouter();
  const target = routeById(to);

  const onClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    navigate(to);
  };

  return (
    <a
      href={target.path}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
    >
      {children}
    </a>
  );
}
