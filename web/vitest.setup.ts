import '@testing-library/jest-dom/vitest';

/**
 * jsdom does not implement `EventSource`, but the Viewing_Display screen (and
 * the SSE hook it uses) construct one on mount. Tests that render the screen
 * through the app shell without injecting a fake factory would otherwise throw
 * `ReferenceError: EventSource is not defined`. Provide a minimal inert stub so
 * those renders succeed; tests that exercise the stream inject their own fake
 * `EventSource` factory and never touch this stub.
 */
if (typeof (globalThis as { EventSource?: unknown }).EventSource === 'undefined') {
  class StubEventSource {
    readonly url: string;
    constructor(url: string) {
      this.url = url;
    }
    addEventListener(): void {}
    removeEventListener(): void {}
    close(): void {}
  }
  (globalThis as { EventSource?: unknown }).EventSource =
    StubEventSource as unknown;
}
