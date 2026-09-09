/**
 * Course Setup screen (task 16.1).
 *
 * The 18-hole par / stroke-index entry form. It is the admin surface for
 * Requirement 1: exactly 18 holes keyed 1..18 (1.1), par as an integer 3..6
 * (1.2), stroke index as an integer 1..18 that is unique across holes (1.3,
 * 1.4), validate-reject-retain with the permitted range shown on bad input
 * (1.5), a save confirmation on a successful persist (1.6), and an
 * incomplete-configuration indicator until every par is valid and the 18 stroke
 * indices form a complete set of 1..18 (1.8, 1.9).
 *
 * The screen is purely presentational over the server-authoritative rules: all
 * persistence and the completeness decision live behind the typed
 * {@link ApiClient} (`GET/PUT /api/course/holes`, `GET /api/course/status`). To
 * keep the field-level save/confirmation contract clean, par and stroke index
 * are saved as independent single-field `PUT`s: each field gets its own
 * confirmation or its own rejection message, and a rejected field never
 * disturbs the other. On rejection the input reverts to the last persisted
 * value (retain-on-reject); the server's message — the permitted range for an
 * out-of-range value, or the conflicting hole ordinal for a duplicate stroke
 * index — is shown inline against the field.
 *
 * A lightweight client-side pre-check rejects empty / non-integer / out-of-range
 * values before a request is issued, giving immediate feedback and the same
 * permitted-range message the server would return (1.5). Any value that passes
 * the pre-check is still authoritative-checked by the server (uniqueness in
 * particular), so the server remains the source of truth.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  HOLE_ORDINALS,
  PAR_MAX,
  PAR_MIN,
  STROKE_INDEX_MAX,
  STROKE_INDEX_MIN,
  type Hole,
  type HoleOrdinal,
  type Par,
  type StrokeIndex,
} from '@ccs/types';
import { apiClient, type ApiClient, type CourseStatus } from '../api/client.js';

/** Which of a hole's two fields an interaction targets. */
type Field = 'par' | 'strokeIndex';

/** The permitted-range message for a field, matching the server's wording. (1.5) */
const RANGE_MESSAGE: Record<Field, string> = {
  par: `Par must be an integer from ${PAR_MIN} to ${PAR_MAX}.`,
  strokeIndex: `Stroke index must be an integer from ${STROKE_INDEX_MIN} to ${STROKE_INDEX_MAX}.`,
};

/** Inclusive bounds per field, used by the client-side pre-check. */
const RANGE_BOUNDS: Record<Field, { readonly min: number; readonly max: number }> = {
  par: { min: PAR_MIN, max: PAR_MAX },
  strokeIndex: { min: STROKE_INDEX_MIN, max: STROKE_INDEX_MAX },
};

/** Per-field, per-hole transient feedback: an inline error or a save confirmation. */
interface Feedback {
  readonly kind: 'error' | 'confirmation';
  readonly message: string;
}

/** Key uniquely identifying one editable field of one hole. */
type FieldKey = `${HoleOrdinal}:${Field}`;

function fieldKey(ordinal: HoleOrdinal, field: Field): FieldKey {
  return `${ordinal}:${field}`;
}

/**
 * The value a hole field currently shows as a string (empty when unset). Derived
 * from the persisted {@link Hole} on load and after each successful save.
 */
function holeFieldText(hole: Hole, field: Field): string {
  const value = field === 'par' ? hole.par : hole.strokeIndex;
  return value === null ? '' : String(value);
}

/**
 * Parse and range-check a raw input string for a field, mirroring the server's
 * accept/reject rule so the UI can reject empty / non-integer / out-of-range
 * values immediately and show the permitted range. Returns the parsed integer
 * when valid, or `null` when the value must be rejected. (1.2, 1.3, 1.5)
 */
function parseFieldValue(raw: string, field: Field): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return null; // empty — reject
  }
  // Reject anything that is not a plain base-10 integer (e.g. "3.5", "4a", "x").
  if (!/^-?\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  const { min, max } = RANGE_BOUNDS[field];
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return null; // out of range — reject
  }
  return parsed;
}

/** Props for {@link CourseSetupScreen}. `client` is injectable for tests. */
export interface CourseSetupScreenProps {
  readonly client?: ApiClient;
}

/**
 * The Course Setup screen: an 18-row par / stroke-index form with inline
 * validation, per-field save confirmations, and an incomplete-configuration
 * indicator, wired to the course endpoints.
 */
export function CourseSetupScreen({
  client = apiClient,
}: CourseSetupScreenProps = {}): JSX.Element {
  // The authoritative, last-persisted holes (source of truth for revert).
  const [holes, setHoles] = useState<readonly Hole[] | null>(null);
  // The current text in each editable input, keyed by hole+field. Diverges from
  // the persisted value only while the admin is mid-edit.
  const [drafts, setDrafts] = useState<Partial<Record<FieldKey, string>>>({});
  // Transient per-field feedback (error or save confirmation).
  const [feedback, setFeedback] = useState<Partial<Record<FieldKey, Feedback>>>(
    {},
  );
  // The course completeness indicator. (1.8, 1.9)
  const [status, setStatus] = useState<CourseStatus | null>(null);
  // A load-time transport error, shown at the top of the screen.
  const [loadError, setLoadError] = useState<string | null>(null);

  /** Refresh the completeness indicator from the server. (1.8, 1.9) */
  const refreshStatus = useCallback(async (): Promise<void> => {
    const result = await client.getCourseStatus();
    if (result.ok) {
      setStatus(result.value);
    }
  }, [client]);

  // Initial load: fetch the 18 holes and the completeness status.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const holesResult = await client.getHoles();
      if (cancelled) return;
      if (holesResult.ok) {
        setHoles(holesResult.value);
        setLoadError(null);
      } else {
        setLoadError(holesResult.error);
      }
      await refreshStatus();
    })();
    return () => {
      cancelled = true;
    };
  }, [client, refreshStatus]);

  /** The current text for a field: the live draft if present, else the persisted value. */
  const textFor = useCallback(
    (hole: Hole, field: Field): string => {
      const key = fieldKey(hole.ordinal, field);
      const draft = drafts[key];
      return draft !== undefined ? draft : holeFieldText(hole, field);
    },
    [drafts],
  );

  /** Record a keystroke into the draft for a field and clear its stale feedback. */
  const onChangeField = useCallback(
    (ordinal: HoleOrdinal, field: Field, raw: string): void => {
      const key = fieldKey(ordinal, field);
      setDrafts((prev) => ({ ...prev, [key]: raw }));
      setFeedback((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    },
    [],
  );

  /** Discard a field's draft, reverting the input to the persisted value. */
  const revertDraft = useCallback((key: FieldKey): void => {
    setDrafts((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  /**
   * Attempt to save a single field. Validates client-side first (reject-retain
   * with the permitted range), then persists via a single-field PUT. On success
   * updates the persisted hole, clears the draft, and shows a confirmation; on a
   * server rejection reverts the input and shows the server's message (permitted
   * range or conflicting hole ordinal). (1.2–1.6)
   */
  const saveField = useCallback(
    async (hole: Hole, field: Field): Promise<void> => {
      const key = fieldKey(hole.ordinal, field);
      // No draft, or draft equals the persisted value: nothing to save.
      const raw = drafts[key];
      if (raw === undefined) return;
      if (raw.trim() === holeFieldText(hole, field)) {
        revertDraft(key);
        return;
      }

      // Client-side pre-check mirrors the server's accept rule. (1.5)
      const parsed = parseFieldValue(raw, field);
      if (parsed === null) {
        revertDraft(key); // retain the previously stored value (1.5)
        setFeedback((prev) => ({
          ...prev,
          [key]: { kind: 'error', message: RANGE_MESSAGE[field] },
        }));
        return;
      }

      const result =
        field === 'par'
          ? await client.putHole({ ordinal: hole.ordinal, par: parsed as Par })
          : await client.putHole({
              ordinal: hole.ordinal,
              strokeIndex: parsed as StrokeIndex,
            });

      if (result.ok) {
        // Persisted: adopt the server's returned hole as the new source of
        // truth, drop the draft, confirm the save. (1.6)
        setHoles((prev) =>
          prev
            ? prev.map((h) => (h.ordinal === result.value.ordinal ? result.value : h))
            : prev,
        );
        revertDraft(key);
        setFeedback((prev) => ({
          ...prev,
          [key]: {
            kind: 'confirmation',
            message:
              field === 'par'
                ? `Par saved for hole ${hole.ordinal}.`
                : `Stroke index saved for hole ${hole.ordinal}.`,
          },
        }));
        await refreshStatus();
      } else {
        // Rejected by the server (e.g. duplicate stroke index): retain the
        // previously stored value and surface the server's message. (1.4, 1.5)
        revertDraft(key);
        setFeedback((prev) => ({
          ...prev,
          [key]: { kind: 'error', message: result.error },
        }));
      }
    },
    [client, drafts, refreshStatus, revertDraft],
  );

  // Whether the course is incomplete (drives the indicator). Defaults to
  // incomplete until the status has loaded, so the indicator is never a false
  // "complete". (1.9)
  const incomplete = status === null ? true : status.incomplete;

  const holeRows = useMemo(() => holes ?? [], [holes]);

  return (
    <section aria-labelledby="course-setup-heading" className="course-setup">
      <h2 id="course-setup-heading">Course Setup</h2>
      <p>
        Enter the par (3–6) and stroke index (1–18, unique) for each of the 18
        holes. Values save when you leave a field.
      </p>

      {loadError !== null && (
        <p role="alert" className="load-error">
          {loadError}
        </p>
      )}

      <p
        className={`config-status ${incomplete ? 'config-status--incomplete' : 'config-status--complete'}`}
        role="status"
        aria-live="polite"
      >
        {incomplete
          ? 'Course configuration is incomplete — all 18 pars and a full set of stroke indices 1 to 18 are required before scoring can use it.'
          : 'Course configuration is complete.'}
      </p>

      {holes === null ? (
        <p aria-live="polite">Loading holes…</p>
      ) : (
        <table className="course-table">
          <caption className="visually-hidden">
            Par and stroke index for holes 1 to 18
          </caption>
          <thead>
            <tr>
              <th scope="col">Hole</th>
              <th scope="col">Par</th>
              <th scope="col">Stroke index</th>
            </tr>
          </thead>
          <tbody>
            {HOLE_ORDINALS.map((ordinal) => {
              const hole =
                holeRows.find((h) => h.ordinal === ordinal) ??
                ({ ordinal, par: null, strokeIndex: null } as Hole);
              return (
                <HoleRow
                  key={ordinal}
                  hole={hole}
                  parText={textFor(hole, 'par')}
                  strokeIndexText={textFor(hole, 'strokeIndex')}
                  parFeedback={feedback[fieldKey(ordinal, 'par')]}
                  strokeIndexFeedback={feedback[fieldKey(ordinal, 'strokeIndex')]}
                  onChangeField={onChangeField}
                  onSaveField={saveField}
                />
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** Props for a single editable hole row. */
interface HoleRowProps {
  readonly hole: Hole;
  readonly parText: string;
  readonly strokeIndexText: string;
  readonly parFeedback: Feedback | undefined;
  readonly strokeIndexFeedback: Feedback | undefined;
  readonly onChangeField: (ordinal: HoleOrdinal, field: Field, raw: string) => void;
  readonly onSaveField: (hole: Hole, field: Field) => void | Promise<void>;
}

/**
 * One row of the course table: the hole ordinal and its two editable fields.
 * Each field saves on blur and on Enter, and renders its inline error or save
 * confirmation beneath the input, associated for assistive tech.
 */
function HoleRow({
  hole,
  parText,
  strokeIndexText,
  parFeedback,
  strokeIndexFeedback,
  onChangeField,
  onSaveField,
}: HoleRowProps): JSX.Element {
  return (
    <tr>
      <th scope="row">{hole.ordinal}</th>
      <td>
        <HoleField
          hole={hole}
          field="par"
          value={parText}
          feedback={parFeedback}
          label={`Par for hole ${hole.ordinal}`}
          onChangeField={onChangeField}
          onSaveField={onSaveField}
        />
      </td>
      <td>
        <HoleField
          hole={hole}
          field="strokeIndex"
          value={strokeIndexText}
          feedback={strokeIndexFeedback}
          label={`Stroke index for hole ${hole.ordinal}`}
          onChangeField={onChangeField}
          onSaveField={onSaveField}
        />
      </td>
    </tr>
  );
}

/** Props for a single editable field (par or stroke index) of a hole. */
interface HoleFieldProps {
  readonly hole: Hole;
  readonly field: Field;
  readonly value: string;
  readonly feedback: Feedback | undefined;
  readonly label: string;
  readonly onChangeField: (ordinal: HoleOrdinal, field: Field, raw: string) => void;
  readonly onSaveField: (hole: Hole, field: Field) => void | Promise<void>;
}

/**
 * A single numeric field with inline feedback. Saves on blur and on Enter. The
 * input is described by its feedback element (via `aria-describedby`) and marked
 * invalid when the feedback is an error, so screen readers announce the
 * permitted range / conflict message.
 */
function HoleField({
  hole,
  field,
  value,
  feedback,
  label,
  onChangeField,
  onSaveField,
}: HoleFieldProps): JSX.Element {
  const { min, max } = RANGE_BOUNDS[field];
  const feedbackId = `${field}-feedback-${hole.ordinal}`;
  const isError = feedback?.kind === 'error';

  return (
    <div className="hole-field">
      <input
        type="number"
        inputMode="numeric"
        aria-label={label}
        min={min}
        max={max}
        step={1}
        value={value}
        aria-invalid={isError || undefined}
        aria-describedby={feedback ? feedbackId : undefined}
        onChange={(event) => onChangeField(hole.ordinal, field, event.target.value)}
        onBlur={() => void onSaveField(hole, field)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
      {feedback && (
        <span
          id={feedbackId}
          className={
            feedback.kind === 'error' ? 'field-error' : 'field-confirmation'
          }
          role={feedback.kind === 'error' ? 'alert' : 'status'}
        >
          {feedback.message}
        </span>
      )}
    </div>
  );
}
