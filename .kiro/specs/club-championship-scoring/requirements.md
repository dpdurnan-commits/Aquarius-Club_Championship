# Requirements Document

## Introduction

The Club Championship Scoring tool is a web-based application for administering a golf club's Club Championship. The competition runs over two days, with 18 holes played each day. Administrators set up the course (par and stroke index per hole) and the competition (players and per-day playing handicaps). Scorers positioned around the course enter each player's stroke count per hole using web or mobile browsers. Scores flow in real time to a web browser view (for example on a monitor in the clubhouse) that can be set to show either the Day 1 or the Day 2 score view, presenting tabulated results including gross strokes, Stableford points, and score relative to par.

The Club Championship comprises two concurrent competitions decided off the same Day 1 hole scores: a Scratch Strokeplay competition, ranked by Day 1 gross strokes with the lowest total ranked first, and a Stableford competition, ranked by Day 1 Stableford points with the highest total ranked first. Each Player holds a separate ordered position in each competition, and those positions can differ.

Between the two rounds, the administrator marks Day 1 as complete and, at the same time, enters a cut value X (a positive integer). Marking Day 1 complete determines which Players advance to Day 2: a Player advances if the Player's position is within the top X in either competition, and a Player is cut if the Player's position is outside the top X in both competitions. Any Player who did not return a Day 1 score (that is, any Player with a No_Return status on Day 1) is not ranked in either competition and is always cut. A cut player does not play Day 2 and is shown as "CUT" on the Day 2 score view.

The tool covers four functional areas: Course Setup, Competition Setup, Scores Display, and Score Entry.

## Glossary

- **System**: The Club Championship Scoring web application as a whole.
- **Course_Setup_Module**: The component that manages hole configuration (ordinal, par, stroke index).
- **Competition_Setup_Module**: The component that manages players and their per-day playing handicaps.
- **Score_Entry_Module**: The scorer-facing component used to record stroke counts for players during play.
- **Scores_Display_Module**: The component that renders the tabulated Day 1 and Day 2 results on the Viewing_Display.
- **Stableford_Calculator**: The component that computes Stableford points from gross strokes, hole par, hole stroke index, and playing handicap.
- **Hole**: A single golf hole, identified by an ordinal number from 1 through 18.
- **Hole_Ordinal**: The sequential number of a hole, an integer from 1 to 18.
- **Par**: The expected number of strokes for a hole under standard play, an integer from 3 to 6.
- **Stroke_Index**: The difficulty ranking of a hole from 1 (hardest) to 18 (easiest), unique across the 18 holes, used to allocate handicap strokes.
- **Player**: A participant in the Club Championship, identified by a name.
- **Playing_Handicap**: The whole number of handicap strokes a player receives over a round, entered per player per day, in the range 0 to 36 inclusive.
- **Handicap_Strokes_On_Hole**: The number of handicap strokes a player receives on a specific hole, derived from Playing_Handicap and Stroke_Index.
- **Gross_Strokes**: The actual number of strokes a player takes on a hole, recorded by a scorer. A hole score may alternatively be recorded as No_Return (NR) instead of a numeric value.
- **No_Return (NR)**: A round status indicating a Player has not returned a complete score for that Day; entered by a scorer as "NR" for a hole. It causes that Day's Aggregate_Strokes and Relative_To_Par to be reported as "NR" while Stableford_Points continue to accumulate from holes with numeric scores.
- **Net_Strokes**: Gross_Strokes minus Handicap_Strokes_On_Hole for a hole.
- **Stableford_Points**: Points earned on a hole based on Net_Strokes relative to Par (net double bogey or worse = 0, net bogey = 1, net par = 2, net birdie = 3, net eagle = 4, net albatross = 5).
- **Relative_To_Par**: The cumulative gross strokes minus cumulative par for holes a player has completed, displayed as a signed value (for example "+2", "-1", or "E" for even).
- **Aggregate_Strokes**: The sum of a player's Gross_Strokes across completed holes.
- **Aggregate_Stableford**: The sum of a player's Stableford_Points across completed holes.
- **Scratch_Strokeplay_Competition**: The ranking of Players by Day 1 Aggregate_Strokes (gross), with the lowest total ranked Competition_Position 1, using standard competition ranking where tied Players share a position. No handicap allowance is applied.
- **Stableford_Competition**: The ranking of Players by Day 1 Aggregate_Stableford, with the highest total ranked Competition_Position 1, using standard competition ranking where tied Players share a position.
- **Competition_Position**: A Player's ordered rank within a given competition using standard competition ranking, where tied Players share the same position and the next position number skips accordingly (for example 1, 2, 2, 4). A Player with a No_Return status on Day 1 is not ranked and has no Competition_Position in either competition.
- **Cut_Value (X)**: A positive integer entered by the administrator when marking Day 1 complete, defining the Competition_Position threshold for advancing to Day 2.
- **Day**: One of the two competition rounds, Day 1 or Day 2, each consisting of 18 holes.
- **Day_1_Complete**: A status set by the administrator indicating that the Day 1 round is finalized. Setting Day_1_Complete triggers evaluation of CUT status for every Player.
- **CUT**: A Player status applied when Day 1 is marked complete, where the Player either has a No_Return status on Day 1 or has a Competition_Position greater than the Cut_Value (X) in both the Scratch_Strokeplay_Competition and the Stableford_Competition; a CUT Player does not participate in Day 2, has no Day 2 scores recorded, and is shown as "CUT" on the Day 2 score view.
- **Viewing_Display**: A web browser displaying the Scores_Display_Module output, which can be set to show either the Day 1 score view or the Day 2 score view (for example on a monitor in the clubhouse).

## Requirements

### Requirement 1: Course Hole Configuration

**User Story:** As an administrator, I want to configure each hole's par and stroke index, so that Stableford scores and relative-to-par values can be calculated correctly.

#### Acceptance Criteria

1. THE Course_Setup_Module SHALL provide entry for exactly 18 holes, each identified by a unique Hole_Ordinal from 1 to 18.
2. WHEN an administrator enters a Par value for a hole, THE Course_Setup_Module SHALL accept integer values from 3 to 6 inclusive.
3. WHEN an administrator enters a Stroke_Index value for a hole, THE Course_Setup_Module SHALL accept integer values from 1 to 18 inclusive.
4. IF an administrator enters a Stroke_Index value that is already assigned to another hole, THEN THE Course_Setup_Module SHALL reject the entry, retain the previously stored value, and display a message identifying the conflicting Hole_Ordinal.
5. IF an administrator enters a Par or Stroke_Index value that is empty, non-integer, or outside the permitted range, THEN THE Course_Setup_Module SHALL reject the entry, retain the previously stored value, and display the permitted range.
6. WHEN an administrator saves a Par or Stroke_Index value, THE Course_Setup_Module SHALL persist the value for the associated Hole_Ordinal and display a save confirmation.
7. WHEN an administrator updates a Par or Stroke_Index value, THE Course_Setup_Module SHALL persist the updated value and make it available to the Stableford_Calculator.
8. WHERE all 18 holes have valid Par values and the 18 Stroke_Index values form a complete set of 1 to 18 with no duplicates or omissions, THE Course_Setup_Module SHALL treat the course configuration as complete.
9. IF the course configuration is not complete, THEN THE Course_Setup_Module SHALL withhold the configuration from the Stableford_Calculator and display an incomplete-configuration indication.

### Requirement 2: Player and Handicap Configuration

**User Story:** As an administrator, I want to enter players and their playing handicap for each day, so that each player's Stableford points are calculated with the correct handicap allowance.

#### Acceptance Criteria

1. WHEN an administrator adds a Player with a non-empty name of 1 to 100 characters, THE Competition_Setup_Module SHALL record the Player name.
2. IF an administrator adds a Player with an empty name or a name exceeding 100 characters, THEN THE Competition_Setup_Module SHALL reject the entry and display a message indicating the permitted name length.
3. IF an administrator adds a Player whose name duplicates an existing Player name, THEN THE Competition_Setup_Module SHALL reject the entry, retain the existing Player unchanged, and display a message indicating the name is already in use.
4. THE Competition_Setup_Module SHALL provide entry of a Day 1 Playing_Handicap and a Day 2 Playing_Handicap for each Player.
5. WHEN an administrator enters a Playing_Handicap, THE Competition_Setup_Module SHALL accept whole number values from 0 to 36 inclusive.
6. IF an administrator enters a Playing_Handicap that is non-integer or outside the range 0 to 36, THEN THE Competition_Setup_Module SHALL reject the entry, retain the previously stored Playing_Handicap value, and display a message indicating the permitted range of 0 to 36.
7. WHERE a Player's Day 2 Playing_Handicap differs from the Day 1 Playing_Handicap, THE Competition_Setup_Module SHALL store both values independently.
8. THE Competition_Setup_Module SHALL persist each Player name and both per-day Playing_Handicap values.
9. WHEN an administrator updates a Player name or a Playing_Handicap, THE Competition_Setup_Module SHALL persist the updated value and make it available to the Stableford_Calculator.
10. IF persistence of a Player name or Playing_Handicap fails, THEN THE Competition_Setup_Module SHALL retain the last successfully stored values and display a message indicating the save did not complete.

### Requirement 3: Day 1 Completion and Cut

**User Story:** As an administrator, I want to mark Day 1 as complete and enter a cut value, so that only players within the top positions of either competition advance to Day 2 and players who did not return a Day 1 score are cut.

#### Acceptance Criteria

1. THE Competition_Setup_Module SHALL provide an action for the administrator to mark Day 1 as complete.
2. WHEN the administrator marks Day 1 as complete, THE Competition_Setup_Module SHALL require the administrator to enter a Cut_Value (X) that is a positive integer.
3. IF the administrator enters a Cut_Value that is empty, non-integer, zero, or negative, THEN THE Competition_Setup_Module SHALL reject the mark-complete action, refrain from setting the Day_1_Complete status, and display a message indicating the Cut_Value must be a positive integer.
4. WHEN the administrator marks Day 1 as complete with a valid Cut_Value (X), THE System SHALL set the Day_1_Complete status and evaluate CUT status for every Player.
5. WHEN the administrator marks Day 1 as complete with a valid Cut_Value (X), THE System SHALL apply CUT status to every Player who has a No_Return status recorded on Day 1.
6. WHEN the administrator marks Day 1 as complete with a valid Cut_Value (X), THE System SHALL apply CUT status to every Player who does not have a No_Return status on Day 1 and whose Competition_Position is greater than X in both the Scratch_Strokeplay_Competition and the Stableford_Competition.
7. WHEN the administrator marks Day 1 as complete with a valid Cut_Value (X), THE System SHALL leave without CUT status every Player who does not have a No_Return status on Day 1 and whose Competition_Position is less than or equal to X in either the Scratch_Strokeplay_Competition or the Stableford_Competition.
8. WHILE Day 1 is not marked complete, THE System SHALL leave every Player without CUT status.
9. WHEN the administrator marks Day 1 as complete, THE System SHALL persist the Day_1_Complete status, the Cut_Value (X), and each Player's CUT status.
10. WHEN the administrator reverses the Day 1 complete action, THE System SHALL clear the Day_1_Complete status, clear the Cut_Value (X), clear CUT status from every Player, and persist the cleared statuses.

### Requirement 4: Handicap Stroke Allocation

**User Story:** As a scorer, I want handicap strokes allocated to holes automatically, so that net scores reflect each player's playing handicap.

#### Acceptance Criteria

1. WHEN a Playing_Handicap and all 18 hole Stroke_Index values are available, THE Stableford_Calculator SHALL allocate one Handicap_Stroke_On_Hole to each hole whose Stroke_Index is less than or equal to the Playing_Handicap.
2. WHERE the Playing_Handicap is greater than 18, THE Stableford_Calculator SHALL allocate an additional Handicap_Stroke_On_Hole to each hole whose Stroke_Index is less than or equal to the Playing_Handicap minus 18.
3. WHEN the Playing_Handicap is 0, THE Stableford_Calculator SHALL allocate zero Handicap_Strokes_On_Hole to every hole.
4. IF a Playing_Handicap or any hole Stroke_Index value is unavailable, THEN THE Stableford_Calculator SHALL withhold Handicap_Stroke_On_Hole allocation and return an indication that inputs are unavailable.

### Requirement 5: Stableford Point Calculation

**User Story:** As a competitor, I want my Stableford points calculated from my net score on each hole, so that my standing reflects the Stableford format.

#### Acceptance Criteria

1. WHEN a Gross_Strokes value that is an integer of 1 or greater is recorded for a hole, THE Stableford_Calculator SHALL compute Net_Strokes as Gross_Strokes minus Handicap_Strokes_On_Hole for that hole.
2. WHEN Net_Strokes equals Par minus 3 or fewer, THE Stableford_Calculator SHALL assign 5 Stableford_Points for that hole.
3. WHEN Net_Strokes equals Par minus 2, THE Stableford_Calculator SHALL assign 4 Stableford_Points for that hole.
4. WHEN Net_Strokes equals Par minus 1, THE Stableford_Calculator SHALL assign 3 Stableford_Points for that hole.
5. WHEN Net_Strokes equals Par, THE Stableford_Calculator SHALL assign 2 Stableford_Points for that hole.
6. WHEN Net_Strokes equals Par plus 1, THE Stableford_Calculator SHALL assign 1 Stableford_Point for that hole.
7. WHEN Net_Strokes equals Par plus 2 or more, THE Stableford_Calculator SHALL assign 0 Stableford_Points for that hole.
8. IF a recorded Gross_Strokes value is non-numeric, non-integer, or less than 1, THEN THE Stableford_Calculator SHALL reject the value, refrain from computing Net_Strokes for that hole, and return an error indication that the Gross_Strokes value is invalid.
9. WHEN no Gross_Strokes value is recorded for a hole, THE Stableford_Calculator SHALL assign 0 Stableford_Points for that hole.
10. WHEN a hole is recorded as No_Return, THE Stableford_Calculator SHALL assign 0 Stableford_Points for that hole.
11. WHERE a Player has a hole recorded as No_Return on a Day, THE Stableford_Calculator SHALL continue to compute Stableford_Points for every other hole of that Day that has a numeric Gross_Strokes value recorded.

### Requirement 6: Competition Ranking

**User Story:** As an administrator, I want Players ranked in both the Scratch Strokeplay and Stableford competitions off the Day 1 scores, so that I can determine each Player's position in each competition and apply the cut.

#### Acceptance Criteria

1. THE System SHALL rank Players in the Scratch_Strokeplay_Competition by Day 1 Aggregate_Strokes ascending, assigning Competition_Position 1 to the lowest total, using standard competition ranking where tied Players share a Competition_Position and subsequent Competition_Positions skip accordingly.
2. THE System SHALL rank Players in the Stableford_Competition by Day 1 Aggregate_Stableford descending, assigning Competition_Position 1 to the highest total, using standard competition ranking where tied Players share a Competition_Position and subsequent Competition_Positions skip accordingly.
3. WHERE a Player has a No_Return status on Day 1, THE System SHALL exclude that Player from ranking in both the Scratch_Strokeplay_Competition and the Stableford_Competition and SHALL assign no Competition_Position to that Player in either competition.
4. WHEN a Day 1 Gross_Strokes value or No_Return status is persisted, THE System SHALL recompute each Player's Competition_Position in both the Scratch_Strokeplay_Competition and the Stableford_Competition within 5 seconds of persistence.

### Requirement 7: Score Entry by Scorers

**User Story:** As a scorer on the course, I want to identify a player and enter their stroke count for a hole, so that live scores reach the central display.

#### Acceptance Criteria

1. THE Score_Entry_Module SHALL present a list of Players from which a scorer selects the Player being scored.
2. THE Score_Entry_Module SHALL allow a scorer to select the Day and the Hole_Ordinal for which a score is entered.
3. WHEN a scorer enters a Gross_Strokes value for a Player on a Hole for a Day, THE Score_Entry_Module SHALL accept only whole integer values from 1 to 20 inclusive.
4. IF a scorer submits a Gross_Strokes value that is empty, non-integer, or outside the range 1 to 20 inclusive, THEN THE Score_Entry_Module SHALL reject the entry, retain any previously recorded value for that Player, Day, and Hole_Ordinal unchanged, and display a message indicating the permitted range of 1 to 20.
5. WHEN a scorer submits a valid Gross_Strokes value, THE Score_Entry_Module SHALL persist the value against the Player, Day, and Hole_Ordinal.
6. WHEN a scorer submits a Gross_Strokes value for a Player, Day, and Hole_Ordinal that already has a recorded value, THE Score_Entry_Module SHALL replace the existing value with the submitted value.
7. WHEN the Score_Entry_Module completes persistence of a submitted Gross_Strokes value, THE Score_Entry_Module SHALL display a confirmation to the scorer within 3 seconds of submission.
8. IF persistence of a submitted Gross_Strokes value does not complete within 3 seconds, THEN THE Score_Entry_Module SHALL display an error indicating the score was not saved and preserve the entered value so the scorer can resubmit.
9. THE Score_Entry_Module SHALL provide all score entry functions when accessed from web browsers and mobile browsers.
10. WHERE two scorers submit Gross_Strokes values for different Players concurrently, THE Score_Entry_Module SHALL persist both values.
11. WHEN a scorer submits "NR" as the score for a Player on a Hole_Ordinal for a Day, THE Score_Entry_Module SHALL persist a No_Return status against that Player, Day, and Hole_Ordinal.
12. WHEN a scorer submits "NR" for a Player, Day, and Hole_Ordinal that already has a recorded Gross_Strokes value or No_Return status, THE Score_Entry_Module SHALL replace the existing value with the No_Return status.
13. WHERE a Player has a No_Return status recorded for a Day, THE Score_Entry_Module SHALL accept and persist numeric Gross_Strokes values for the remaining Hole_Ordinals of that Day for that Player.
14. IF a Player has CUT status, THEN THE Score_Entry_Module SHALL reject any Day 2 Gross_Strokes value or "NR" submission for that Player, refrain from persisting a Day 2 value for that Player, and display a message indicating the Player is cut.

### Requirement 8: Day 1 Scores Display

**User Story:** As a viewer in the clubhouse, I want to see the Day 1 results table with each player's position in both competitions, so that I can follow each player's progress and standing on the first round.

#### Acceptance Criteria

1. THE Scores_Display_Module SHALL present a Day 1 table with a header row showing Hole_Ordinal, Par, and Stroke_Index for holes 1 through 18 in ascending Hole_Ordinal order from 1 to 18.
2. THE Scores_Display_Module SHALL present one row per Player showing the Player name and the Player's Day 1 Playing_Handicap.
3. WHILE a Gross_Strokes value has been recorded for a Player on a Day 1 hole, THE Scores_Display_Module SHALL display the Gross_Strokes value followed by the Stableford_Points value in brackets within the same cell, formatted as "strokes (points)".
4. IF no Gross_Strokes value has been recorded for a Player on a Day 1 hole, THEN THE Scores_Display_Module SHALL display an empty cell for that hole.
5. THE Scores_Display_Module SHALL display, at the end of each Player row, an Aggregate_Strokes cell summing the Player's Day 1 Gross_Strokes across the Player's completed Day 1 holes, where a completed hole is any Day 1 hole for which a Gross_Strokes value has been recorded for that Player.
6. THE Scores_Display_Module SHALL display, in the Aggregate_Strokes cell, the Player's Aggregate_Strokes total followed by the Player's Scratch_Strokeplay_Competition Competition_Position in brackets, formatted as "total (position)".
7. THE Scores_Display_Module SHALL display, at the end of each Player row, an Aggregate_Stableford cell summing the Player's Day 1 Stableford_Points across the Player's completed Day 1 holes.
8. THE Scores_Display_Module SHALL display, in the Aggregate_Stableford cell, the Player's Aggregate_Stableford total followed by the Player's Stableford_Competition Competition_Position in brackets, formatted as "total (position)".
9. THE Scores_Display_Module SHALL display, at the end of each Player row, a Relative_To_Par cell equal to the Player's Day 1 Aggregate_Strokes minus the total Par of the Player's completed Day 1 holes, formatted as a signed value with a leading "+" for values greater than zero, a leading "-" for values less than zero, and displayed as "0" for a value of zero.
10. IF a Player has no completed Day 1 holes, THEN THE Scores_Display_Module SHALL display 0 in the Aggregate_Strokes cell, 0 in the Aggregate_Stableford cell, and an empty Relative_To_Par cell for that Player.
11. WHERE a Day 1 hole is recorded as No_Return for a Player, THE Scores_Display_Module SHALL display "NR" in that hole's cell.
12. WHERE a Player has any Day 1 hole recorded as No_Return, THE Scores_Display_Module SHALL display "NR" as the total in that Player's Aggregate_Strokes cell instead of a numeric total, and SHALL display "NR" as the bracketed Scratch_Strokeplay_Competition position, formatted as "NR (NR)".
13. WHERE a Player has any Day 1 hole recorded as No_Return, THE Scores_Display_Module SHALL display "NR" as the bracketed Stableford_Competition position in that Player's Aggregate_Stableford cell.
14. WHERE a Player has any Day 1 hole recorded as No_Return, THE Scores_Display_Module SHALL display "NR" in that Player's Relative_To_Par cell instead of a signed value.
15. WHERE a Player has any Day 1 hole recorded as No_Return, THE Scores_Display_Module SHALL display in that Player's Aggregate_Stableford cell the sum of the Player's Day 1 Stableford_Points across all Day 1 holes for which a numeric Gross_Strokes value has been recorded.

### Requirement 9: Day 2 Scores Display

**User Story:** As a viewer in the clubhouse, I want to see the Day 2 results table with cumulative context from Day 1, so that I can follow the overall championship standing.

#### Acceptance Criteria

1. THE Scores_Display_Module SHALL present a Day 2 table with a header row showing Hole_Ordinal, Par, and Stroke_Index for holes 1 through 18 arranged in ascending Hole_Ordinal order from left to right.
2. THE Scores_Display_Module SHALL present one row per Player showing the Player name and the Player's Day 2 Playing_Handicap.
3. THE Scores_Display_Module SHALL display Player rows that do not have CUT status in ascending order of each Player's Relative_To_Par value, and WHERE two or more Players without CUT status share the same Relative_To_Par value, THE Scores_Display_Module SHALL order those Players alphabetically by Player name.
4. THE Scores_Display_Module SHALL display Player rows that have CUT status after all Player rows that do not have CUT status, ordered alphabetically by Player name.
5. THE Scores_Display_Module SHALL display, in each Player row, the Player's Day 1 Aggregate_Strokes in a dedicated column.
6. WHERE a Gross_Strokes value has been recorded for a Player on a Day 2 hole, THE Scores_Display_Module SHALL display, in that hole's cell, the Gross_Strokes value followed by the Stableford_Points value in brackets, formatted as "strokes (points)".
7. WHERE no Gross_Strokes value has been recorded for a Player on a Day 2 hole, THE Scores_Display_Module SHALL display an empty cell containing no characters for that hole.
8. THE Scores_Display_Module SHALL display, at the end of each Player row, a combined strokes cell showing the Player's Day 1 Aggregate_Strokes followed by the Player's Day 2 Aggregate_Strokes in brackets, formatted as "day1total (day2total)".
9. THE Scores_Display_Module SHALL display, at the end of each Player row, a combined Stableford cell showing the Player's Aggregate_Stableford across 36 holes followed by the Player's Day 2 Aggregate_Stableford in brackets, formatted as "total36 (day2total)".
10. THE Scores_Display_Module SHALL display, at the end of each Player row, a Relative_To_Par cell equal to the Player's combined Day 1 and Day 2 Aggregate_Strokes minus the total Par of only the Player's completed Day 1 and Day 2 holes, formatted with a leading "+" when the value is greater than zero, a leading "-" when the value is less than zero, and displayed as "0" when the value equals zero.
11. WHERE a Day 2 hole is recorded as No_Return for a Player, THE Scores_Display_Module SHALL display "NR" in that hole's cell.
12. WHERE a Player has any Day 1 hole recorded as No_Return, THE Scores_Display_Module SHALL display "NR" as the Day 1 portion of the combined strokes cell, formatted as "NR (day2total)".
13. WHERE a Player has any Day 2 hole recorded as No_Return, THE Scores_Display_Module SHALL display "NR" as the bracketed Day 2 portion of the combined strokes cell, formatted as "day1total (NR)".
14. WHERE a Player has any Day 1 hole recorded as No_Return AND any Day 2 hole recorded as No_Return, THE Scores_Display_Module SHALL display the combined strokes cell formatted as "NR (NR)".
15. WHERE a Player has any Day 1 hole recorded as No_Return OR any Day 2 hole recorded as No_Return, THE Scores_Display_Module SHALL display "NR" in that Player's combined Relative_To_Par cell instead of a signed value.
16. THE Scores_Display_Module SHALL display, in the combined Stableford cell, the Player's Aggregate_Stableford summed across all Day 1 and Day 2 holes for which a numeric Gross_Strokes value has been recorded, followed by the Player's Day 2 Aggregate_Stableford in brackets, regardless of whether either Day has a hole recorded as No_Return.
17. WHERE a Player has CUT status, THE Scores_Display_Module SHALL display "CUT" against that Player's name on the Day 2 table.
18. WHERE a Player has CUT status, THE Scores_Display_Module SHALL display no Day 2 hole scores, no Day 2 Aggregate_Strokes, and no Day 2 aggregate totals for that Player on the Day 2 table.

### Requirement 10: Real-Time Display Updates

**User Story:** As a viewer in the clubhouse, I want the Viewing_Display to update automatically as scorers enter scores, so that the display always reflects current results without manual refresh.

#### Acceptance Criteria

1. WHEN a Gross_Strokes value is persisted by the Score_Entry_Module, THE Scores_Display_Module SHALL update the affected Player row on the Viewing_Display within 5 seconds of persistence.
2. WHEN a Gross_Strokes value is persisted, THE Scores_Display_Module SHALL recompute and update the affected Aggregate_Strokes, Aggregate_Stableford, Relative_To_Par, and Competition_Position cells within 5 seconds of persistence.
3. THE Scores_Display_Module SHALL update the Viewing_Display without requiring a manual page reload.
4. IF the connection between the Viewing_Display and the System is interrupted, THEN THE Scores_Display_Module SHALL display a connection-status indicator identifying the interrupted state within 10 seconds of the interruption.
5. WHEN the connection between the Viewing_Display and the System is restored, THE Scores_Display_Module SHALL remove the connection-status indicator and apply all Gross_Strokes values persisted during the interruption within 5 seconds of restoration.
6. THE Viewing_Display SHALL allow selection of whether the Viewing_Display shows the Day 1 score view or the Day 2 score view, and SHALL retain the selected view across real-time updates.
