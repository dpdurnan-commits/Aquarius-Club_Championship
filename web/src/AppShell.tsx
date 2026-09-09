/**
 * The application shell (task 15.1).
 *
 * Composes the four functional areas into a single navigable app: a header with
 * the title and a nav bar of {@link RouterLink}s, and a main region that renders
 * the screen matching the active route. The screens themselves are placeholders
 * here (implemented in tasks 16–18); this shell establishes the navigation and
 * routing seam they slot into and is mobile-friendly (a simple wrapping nav).
 * (Requirement 7.9)
 */

import { ROUTES, useRouter, RouterLink, type RouteId } from './routing/router.js';
import { CourseSetupScreen } from './screens/CourseSetupScreen.js';
import { CompetitionSetupScreen } from './screens/CompetitionSetupScreen.js';
import { ScoreEntryScreen } from './screens/ScoreEntryScreen.js';
import { ViewingDisplayScreen } from './screens/ViewingDisplayScreen.js';

/** Render the screen component for the active route. */
function ActiveScreen({ route }: { route: RouteId }): JSX.Element {
  switch (route) {
    case 'course-setup':
      return <CourseSetupScreen />;
    case 'competition-setup':
      return <CompetitionSetupScreen />;
    case 'score-entry':
      return <ScoreEntryScreen />;
    case 'viewing-display':
      return <ViewingDisplayScreen />;
    default:
      return <ViewingDisplayScreen />;
  }
}

/**
 * The shell layout: title, primary navigation, and the active screen. Reads the
 * active route from the router and highlights the matching nav link.
 */
export function AppShell(): JSX.Element {
  const { current } = useRouter();

  return (
    <div className="app-shell">
      <header>
        <h1>Club Championship Scoring</h1>
        <nav aria-label="Primary">
          <ul>
            {ROUTES.map((route) => (
              <li key={route.id}>
                <RouterLink to={route.id} active={route.id === current}>
                  {route.label}
                </RouterLink>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main>
        <ActiveScreen route={current} />
      </main>
    </div>
  );
}
