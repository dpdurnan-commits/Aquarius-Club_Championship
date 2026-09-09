# Implementation Plan: Club Championship Scoring

## Overview

This plan builds the Club Championship Scoring tool incrementally, following the server-authoritative, recompute-on-read design. Work starts with the pure scoring/handicap/ranking/cut domain logic and its property-based tests (validated in isolation with no I/O), then layers on SQLite persistence and the repository, the domain services that coordinate persistence + calculation, the REST API, the SSE/event-broker real-time layer, and finally the React + Vite frontend. Each step builds on the previous one and ends by wiring new code into the running app so nothing is left orphaned.

Stack per the design: Node.js + TypeScript backend (Fastify), SQLite persistence (better-sqlite3), an in-process event broker with Server-Sent Events, and a React + TypeScript + Vite frontend. Property-based tests use **fast-check** (minimum 100 iterations each), tagged `Feature: club-championship-scoring, Property {number}: {property_text}`.

## Tasks

- [x] 1. Scaffold the monorepo, tooling, and shared domain types
  - Create a workspace with `server/` (Node.js + TypeScript + Fastify) and `web/` (React + TypeScript + Vite) packages, plus a shared `types` module for domain types.
  - Configure TypeScript (strict mode), the test runner (Vitest), fast-check, ESLint, and npm scripts for `build`, `test`, and `test --run`.
  - Define shared domain types and constants: `Day` (1|2), `HoleOrdinal` (1..18), `Par`, `StrokeIndex`, `PlayingHandicap`, `Gross`, cell state (`unrecorded | numeric | NR`), and the view snapshot shapes (`Day1View`, `Day2View`) referenced by the assembler.
  - Add a validation-result type (`Result<T>` with ok/error + message) used consistently across services.
  - _Requirements: 1.1, 2.4, 7.1, 7.2_

- [x] 2. Implement the StablefordCalculator pure functions
  - [x] 2.1 Implement handicap stroke allocation
    - Implement `allocateHandicapStrokes(playingHandicap, strokeIndexByHole)`: one stroke where `strokeIndex <= H`, a second where `strokeIndex <= H - 18`, zero for `H = 0`; return an `INPUTS_UNAVAILABLE` indication when the handicap or any stroke index is missing.
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [x] 2.2 Write property test for handicap allocation correctness
    - **Property 7: Handicap stroke allocation is correct and totals the handicap**
    - **Validates: Requirements 4.1, 4.2, 4.3**
    - Use the handicap generator (integers 0..36 with 0, 18, 36 as boundary cases) and a stroke-index permutation of {1..18}; assert per-hole allocation, max 2 strokes/hole, and total allocated equals H.

  - [x] 2.3 Write property test for unavailable allocation inputs
    - **Property 8: Allocation requires available inputs**
    - **Validates: Requirements 4.4**

  - [x] 2.4 Implement net strokes and Stableford points mapping
    - Implement `netStrokes(gross, handicapStrokesOnHole)` and `stablefordPoints(net, par)` per the tiered mapping (diff <= -3 -> 5, -2 -> 4, -1 -> 3, 0 -> 2, +1 -> 1, >= +2 -> 0).
    - Implement `stablefordForHole(gross, par, handicapStrokesOnHole)` returning 0 for NR/unrecorded and an `INVALID` indication for non-integer or `< 1` gross.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10_

  - [x] 2.5 Write property test for Stableford points mapping
    - **Property 9: Stableford points mapping**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7**

  - [x] 2.6 Write property test for monotonicity in gross
    - **Property 10: Points are monotonically non-increasing in gross**
    - **Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.6, 5.7**

  - [x] 2.7 Write property test for invalid gross yielding no computation
    - **Property 11: Invalid gross yields no computation**
    - **Validates: Requirements 5.8**

  - [x] 2.8 Write unit tests for boundary handicaps and worked Stableford examples
    - Concrete examples for H=0, H=18, H=36 allocation and a known scorecard -> known points as regression anchors.
    - _Requirements: 4.3, 5.1, 5.5_

- [x] 3. Implement day aggregation helpers (pure)
  - [x] 3.1 Implement completed-holes and aggregate helpers
    - Implement `completedHoles`, `aggregateStrokes` (numeric holes only), `aggregateStableford` (sum of points over numeric holes, NR/unrecorded contribute 0), `relativeToPar`, and a `hasNROnDay` predicate, all from raw Score + Hole + Player inputs.
    - _Requirements: 5.11, 8.5, 8.7, 8.9, 8.15, 9.16_

  - [x] 3.2 Write property test for aggregate Stableford independent of NR
    - **Property 12: Aggregate Stableford sums only numeric holes, independent of NR**
    - **Validates: Requirements 5.9, 5.10, 5.11, 8.7, 8.15, 9.16**

- [x] 4. Implement the RankingAndCutService domain logic (pure)
  - [x] 4.1 Implement standard competition ranking with ties
    - Implement `rankScratch` (Day 1 aggregate gross ascending) and `rankStableford` (Day 1 aggregate Stableford descending) using standard competition ranking (ties share a position, next position skips); NR players excluded with `null` position.
    - _Requirements: 6.1, 6.2, 6.3_

  - [x] 4.2 Write property test for standard competition ranking
    - **Property 13: Standard competition ranking with ties**
    - **Validates: Requirements 6.1, 6.2**

  - [x] 4.3 Write property test for NR players unranked
    - **Property 14: NR players are unranked in both competitions**
    - **Validates: Requirements 6.3**

  - [x] 4.4 Implement cut evaluation
    - Implement `evaluateCut(cutValue, scratchPositions, stablefordPositions, hasNRDay1)`: CUT if Day 1 NR, or position > X in both competitions; advance if position <= X in at least one competition.
    - _Requirements: 3.4, 3.5, 3.6, 3.7_

  - [x] 4.5 Write property test for cut decision correctness
    - **Property 15: Cut decision correctness**
    - **Validates: Requirements 3.4, 3.5, 3.6, 3.7**

- [x] 5. Checkpoint - core scoring, ranking, and cut math
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement the SQLite schema and repository layer
  - [x] 6.1 Create the SQLite schema and database bootstrap
    - Create tables for `HOLE` (18 rows keyed by ordinal, nullable par/strokeIndex), `PLAYER` (id, name unique, handicapDay1, handicapDay2, cut), `SCORE` (unique key `(playerId, day, ordinal)`, gross nullable, noReturn), and single-row `COMPETITION_STATE` (day1Complete, cutValue).
    - Add DB open/migration bootstrap that seeds the 18 hole rows and the single competition-state row on first run.
    - _Requirements: 1.1, 3.8_

  - [x] 6.2 Implement the Repository with CRUD and cell upsert
    - Implement read/write methods for holes, players, scores (upsert per `(playerId, day, ordinal)` cell), competition state, and cut flags; each score upsert runs in its own transaction.
    - _Requirements: 1.6, 1.7, 2.8, 2.9, 7.5, 7.6, 7.10, 3.9_

  - [x] 6.3 Write property test for configuration persistence round-trip
    - **Property 4: Configuration persistence round-trip**
    - **Validates: Requirements 1.6, 1.7, 2.8, 2.9**

  - [x] 6.4 Write property test for score cell last-write-wins
    - **Property 20: Score cell is last-write-wins**
    - **Validates: Requirements 7.5, 7.6, 7.11, 7.12**

  - [x] 6.5 Write property test for independent concurrent cell writes
    - **Property 21: Cells are independent under concurrent writes**
    - **Validates: Requirements 7.10, 7.13**

- [x] 7. Implement the CourseSetupService
  - [x] 7.1 Implement par and stroke-index validation and persistence
    - Implement `setPar` (integer 3..6; retain stored value + return permitted range on failure) and `setStrokeIndex` (integer 1..18 + uniqueness; on duplicate return the conflicting hole ordinal and retain stored value), plus `getHoles` and save confirmation.
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_

  - [x] 7.2 Implement course completeness predicate and gating
    - Implement `isCourseComplete` (all 18 pars valid AND stroke indices a permutation of {1..18}); return an incomplete-configuration indication and withhold config from the calculator when incomplete.
    - _Requirements: 1.8, 1.9_

  - [x] 7.3 Write property test for par validation range
    - **Property 1: Par validation is exactly the range 3..6**
    - **Validates: Requirements 1.2, 1.5**

  - [x] 7.4 Write property test for stroke-index validation and uniqueness
    - **Property 2: Stroke index validation is the range 1..18 plus uniqueness**
    - **Validates: Requirements 1.3, 1.4, 1.5**

  - [x] 7.5 Write property test for course completeness predicate
    - **Property 3: Course completeness predicate**
    - **Validates: Requirements 1.8, 1.9**

  - [x] 7.6 Write unit tests for 18-hole slot presence
    - Concrete test that exactly 18 hole slots exist keyed 1..18.
    - _Requirements: 1.1_

- [x] 8. Implement the CompetitionSetupService (players, handicaps, Day 1 completion/cut)
  - [x] 8.1 Implement player and handicap management
    - Implement `addPlayer` (name length 1..100 + uniqueness), `setHandicap(playerId, day, handicap)` (integer 0..36, Day 1/Day 2 stored independently), and `updatePlayer` with persistence-failure handling that retains last stored values and reports the save did not complete.
    - _Requirements: 2.1, 2.2, 2.3, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10_

  - [x] 8.2 Write property test for player name validation
    - **Property 5: Player name validation is length 1..100 plus uniqueness**
    - **Validates: Requirements 2.1, 2.2, 2.3**

  - [x] 8.3 Write property test for handicap validation and per-day independence
    - **Property 6: Handicap validation and per-day independence**
    - **Validates: Requirements 2.5, 2.6, 2.7**

  - [x] 8.4 Write unit tests for persistence-failure handling
    - Inject a persistence fault and assert last stored values retained + "save did not complete" message; assert both per-day handicap fields exist.
    - _Requirements: 2.4, 2.10_

  - [x] 8.5 Implement Day 1 completion and reversal
    - Implement `markDay1Complete(cutValue)` (require positive integer; on invalid do not set Day_1_Complete and return "must be a positive integer"); on success set Day_1_Complete, persist cut value, invoke RankingAndCutService to evaluate + persist CUT for every player. Implement `reverseDay1Complete` to clear Day_1_Complete, cut value, and all CUT flags and persist.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10_

  - [x] 8.6 Write property test for cut value validation gating
    - **Property 16: Cut value validation gates completion**
    - **Validates: Requirements 3.2, 3.3**

  - [x] 8.7 Write property test for no cut before completion
    - **Property 17: No cut before completion**
    - **Validates: Requirements 3.8**

  - [x] 8.8 Write property test for completion/reversal round-trip
    - **Property 18: Day 1 completion and reversal round-trip**
    - **Validates: Requirements 3.9, 3.10**

  - [x] 8.9 Write unit test for mark-complete action presence
    - _Requirements: 3.1_

- [x] 9. Implement the ScoreEntryService
  - [x] 9.1 Implement score submission with validation and CUT gating
    - Implement `submitScore(playerId, day, ordinal, value)` where value is integer 1..20 or `NR`: reject out-of-range/empty/non-integer and retain prior value with the 1..20 message; upsert valid numeric (replacing existing); upsert NR (replacing existing); reject Day 2 submissions for CUT players (do not persist, return "player is cut"). Return confirmation on success and a save-failed indication on persistence timeout that preserves the entered value.
    - _Requirements: 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.11, 7.12, 7.13, 7.14_

  - [x] 9.2 Write property test for score value validation
    - **Property 19: Score value validation is the range 1..20 or NR**
    - **Validates: Requirements 7.3, 7.4**

  - [x] 9.3 Write property test for cut players cannot receive Day 2 scores
    - **Property 22: Cut players cannot receive Day 2 scores**
    - **Validates: Requirements 7.14**

  - [x] 9.4 Write unit test for score-submit timeout handling
    - Inject a persistence delay and assert "score not saved" error + entered value preserved for resubmission.
    - _Requirements: 7.8_

- [x] 10. Implement the ScoresDisplayAssembler
  - [x] 10.1 Implement Day 1 view assembly
    - Implement `buildDay1View`: header (ordinal/par/SI 1..18 ascending), per-hole `"gross (points)"`/`"NR"`/empty cells, aggregate-strokes `"total (position)"`, aggregate-Stableford `"total (position)"`, signed relative-to-par, and NR / no-completed-holes handling.
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9, 8.10, 8.11, 8.12, 8.13, 8.14, 8.15_

  - [x] 10.2 Write property test for Day 1 aggregate + relative-to-par over completed holes
    - **Property 23: Aggregate strokes and relative-to-par over completed holes**
    - **Validates: Requirements 8.5, 8.9, 8.10**

  - [x] 10.3 Write property test for Day 1 hole cell format
    - **Property 24: Day 1 hole cell format**
    - **Validates: Requirements 8.3, 8.4, 8.11**

  - [x] 10.4 Write property test for Day 1 aggregate cell format with position
    - **Property 25: Day 1 aggregate cell format with position**
    - **Validates: Requirements 8.6, 8.8**

  - [x] 10.5 Write property test for Day 1 NR rendering
    - **Property 26: Day 1 NR rendering**
    - **Validates: Requirements 8.12, 8.13, 8.14, 8.15**

  - [x] 10.6 Write unit tests for Day 1 header and empty-state rendering
    - Concrete tests for 18-hole header content/order and no-completed-holes (0 / 0 / empty).
    - _Requirements: 8.1, 8.2, 8.10_

  - [x] 10.7 Implement Day 2 view assembly
    - Implement `buildDay2View`: header, ordering (non-CUT by cumulative relative-to-par ascending then alphabetical; CUT last, alphabetical), Day 1 aggregate column, per-hole Day 2 cells, combined strokes `"day1total (day2total)"`, combined Stableford `"total36 (day2total)"`, cumulative relative-to-par, and CUT/NR handling.
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 9.10, 9.11, 9.12, 9.13, 9.14, 9.15, 9.16, 9.17, 9.18_

  - [x] 10.8 Write property test for Day 2 ordering
    - **Property 27: Day 2 ordering**
    - **Validates: Requirements 9.3, 9.4**

  - [x] 10.9 Write property test for Day 2 hole cell format
    - **Property 28: Day 2 hole cell format**
    - **Validates: Requirements 9.6, 9.7, 9.11**

  - [x] 10.10 Write property test for Day 2 combined cells and cumulative relative-to-par
    - **Property 29: Day 2 combined cells and cumulative relative-to-par**
    - **Validates: Requirements 9.5, 9.8, 9.9, 9.10, 9.16**

  - [x] 10.11 Write property test for Day 2 combined NR substitution
    - **Property 30: Day 2 combined NR substitution**
    - **Validates: Requirements 9.12, 9.13, 9.14, 9.15, 9.16**

  - [x] 10.12 Write property test for CUT player Day 2 rendering
    - **Property 31: CUT player Day 2 rendering**
    - **Validates: Requirements 9.17, 9.18**

  - [x] 10.13 Write unit test for Day 2 header content/order
    - _Requirements: 9.1, 9.2_

- [x] 11. Checkpoint - persistence, services, and view assembly
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Implement the in-process event broker
  - [x] 12.1 Implement the EventBroker with sequence ids and replay buffer
    - Implement an in-process broker that assigns a monotonically increasing sequence id to each event (`score-changed`, `day1-status-changed`, `course-changed`, `player-changed`), fans out to subscribers, and retains a bounded buffer of recent events for `Last-Event-ID` replay.
    - _Requirements: 10.1, 10.2, 10.5_

  - [x] 12.2 Write unit tests for broker fan-out and replay
    - Assert every subscriber receives each event with an increasing id and that replay from a given id returns only subsequent events.
    - _Requirements: 10.1, 10.5_

  - [x] 12.3 Emit events from the domain services
    - Wire ScoreEntryService (score-changed), CompetitionSetupService (day1-status-changed, player-changed), and CourseSetupService (course-changed) to emit broker events after successful persistence.
    - _Requirements: 10.1, 10.2_

- [x] 13. Implement the REST API and SSE endpoint (Fastify)
  - [x] 13.1 Wire up the Fastify server and dependency wiring
    - Create the server entrypoint that instantiates the repository, domain services, and broker, and registers routes; serve the built frontend static assets.
    - _Requirements: 7.9_

  - [x] 13.2 Implement course, player, and Day 1 endpoints
    - Implement `GET/PUT /api/course/holes`, `GET /api/course/status`, `GET/POST/PUT /api/players`, `POST /api/day1/complete`, and `DELETE /api/day1/complete`, delegating to the services and returning validation results/messages.
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 1.9, 2.1, 2.2, 2.3, 2.5, 2.6, 3.1, 3.2, 3.3, 3.9, 3.10_

  - [x] 13.3 Implement score and view endpoints
    - Implement `POST /api/scores` (numeric or NR) and `GET /api/view/day1` / `GET /api/view/day2` returning assembler snapshots.
    - _Requirements: 7.3, 7.4, 7.5, 7.6, 7.11, 7.12, 7.14, 8.1, 9.1_

  - [x] 13.4 Implement the SSE `/api/events` endpoint
    - Stream broker events with incrementing `id`, emit periodic heartbeat comments, and honor `Last-Event-ID` for replay/resync.
    - _Requirements: 10.1, 10.2, 10.3, 10.5_

  - [x] 13.5 Write API-level unit/integration tests for endpoints
    - Assert validation-error responses (retain-and-message), successful upserts, and view snapshot shapes via injected in-memory repository.
    - _Requirements: 1.5, 2.6, 3.3, 7.4, 7.14_

  - [x] 13.6 Write integration test for recompute + SSE push within budget
    - Persist a Day 1 score, assert positions recompute and the updated row/aggregates push over SSE without reload within 5s; assert score-entry confirmation within 3s.
    - _Requirements: 6.4, 7.7, 10.1, 10.2, 10.3_

- [x] 14. Checkpoint - backend API and real-time layer
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Implement the React frontend shell and API/SSE clients
  - [x] 15.1 Implement the app shell, routing, and API client
    - Create the Vite React app shell with routing across Course Setup, Competition Setup, Score Entry, and Viewing_Display, plus a typed API client for the REST endpoints.
    - _Requirements: 7.9_

  - [x] 15.2 Implement the SSE client hook with connection status and resync
    - Implement an `EventSource`-based hook that tracks connection status, shows a connection-status indicator on `onerror` within 10s, and on reconnect clears the indicator and reloads the current view snapshot within 5s (using `Last-Event-ID` semantics).
    - _Requirements: 10.3, 10.4, 10.5_

  - [x] 15.3 Write unit tests for the SSE hook status transitions
    - Simulate connection drop/restore and assert indicator show/clear and snapshot reload behavior.
    - _Requirements: 10.4, 10.5_

- [x] 16. Implement the Course Setup and Competition Setup UI
  - [x] 16.1 Implement Course Setup screen
    - Build the 18-hole par/stroke-index entry form with inline validation messaging (permitted ranges, duplicate stroke-index conflict), save confirmation, and an incomplete-configuration indicator, wired to the course endpoints.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 1.9_

  - [x] 16.2 Implement Competition Setup screen (players, handicaps, Day 1 complete)
    - Build player add/edit with Day 1/Day 2 handicap fields and validation messaging, plus the mark-Day-1-complete action with cut-value entry and the reverse action, wired to the player and Day 1 endpoints.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.1, 3.2, 3.3, 3.10_

- [x] 17. Implement the Score Entry UI
  - [x] 17.1 Implement the mobile-friendly score entry screen
    - Build player selection, day/hole selection, gross/NR entry with 1..20 validation messaging, submit confirmation within 3s, save-failed handling that preserves the entered value, and the cut-player rejection message; ensure responsive layout for web and mobile.
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.7, 7.8, 7.9, 7.11, 7.14_

- [x] 18. Implement the Viewing_Display UI
  - [x] 18.1 Implement Day 1 and Day 2 view tables with day selection
    - Build the Day 1 and Day 2 score tables rendering the server-assembled snapshots (cells, aggregates, positions, relative-to-par, CUT/NR), a Day 1/Day 2 view selector retained across real-time updates, and live updates driven by the SSE hook without manual reload.
    - _Requirements: 8.1, 8.2, 8.3, 9.1, 9.2, 9.17, 10.3, 10.6_

  - [x] 18.2 Write unit test for selected-view retention across updates
    - **Property 32: Selected view is retained across updates**
    - **Validates: Requirements 10.6**

- [x] 19. End-to-end integration and final wiring
  - [x] 19.1 Wire frontend to backend and add build integration
    - Ensure the backend serves the built frontend assets and that the full flow (setup -> score entry -> live display) is connected end to end.
    - _Requirements: 7.9, 10.3_

  - [x] 19.2 Write end-to-end integration test
    - Automated scenario: configure course + players, enter Day 1 scores including an NR and ties, mark Day 1 complete with a cut value, verify advance/cut, attempt a blocked Day 2 entry for a cut player, and confirm Day 1 and Day 2 views render correctly.
    - _Requirements: 3.4, 6.4, 7.14, 8.1, 9.1, 9.17_

- [x] 20. Final checkpoint - full system tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test tasks and can be skipped for a faster MVP, but they carry the property-based coverage of the design's 32 correctness properties and the example/integration coverage from the testing strategy.
- Each property-based test uses **fast-check** with a minimum of 100 iterations and is tagged `Feature: club-championship-scoring, Property {number}: {property_text}`. Do not hand-roll generators.
- Property tests are placed close to the implementation they cover so scoring/ranking/cut errors are caught before persistence, API, and UI are wired up.
- Timing/real-time and cross-device criteria (6.4, 7.7, 7.9, 10.1-10.5) are covered by integration/example tests rather than properties, per the design's testing strategy.
- Each task references specific requirement sub-clauses (and, for test tasks, the specific design property) for traceability.
- Checkpoints ensure incremental validation at natural boundaries (core math, persistence + services, backend API, full system).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "2.4", "3.1", "4.1", "4.4"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.5", "2.6", "2.7", "2.8", "3.2", "4.2", "4.3", "4.5"] },
    { "id": 3, "tasks": ["6.1"] },
    { "id": 4, "tasks": ["6.2", "7.1", "7.2", "8.1", "8.5", "9.1", "10.1", "10.7"] },
    { "id": 5, "tasks": ["6.3", "6.4", "6.5", "7.3", "7.4", "7.5", "7.6", "8.2", "8.3", "8.4", "8.6", "8.7", "8.8", "8.9", "9.2", "9.3", "9.4", "10.2", "10.3", "10.4", "10.5", "10.6", "10.8", "10.9", "10.10", "10.11", "10.12", "10.13"] },
    { "id": 6, "tasks": ["12.1"] },
    { "id": 7, "tasks": ["12.2", "12.3"] },
    { "id": 8, "tasks": ["13.1"] },
    { "id": 9, "tasks": ["13.2", "13.3", "13.4"] },
    { "id": 10, "tasks": ["13.5", "13.6"] },
    { "id": 11, "tasks": ["15.1"] },
    { "id": 12, "tasks": ["15.2", "16.1", "16.2", "17.1", "18.1"] },
    { "id": 13, "tasks": ["15.3", "18.2", "19.1"] },
    { "id": 14, "tasks": ["19.2"] }
  ]
}
```
