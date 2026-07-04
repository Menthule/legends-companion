// Current stance / invocation tracking from log lines (Legends' martial
// stance + invocation system). Verified line shapes (fixtures/sample_session
// .txt + docs/research-triggers.md LEGENDS-VERIFIED):
//   "You begin to change your stance."          (transition begins, unnamed)
//   "You assume a striker stance."              (completion — NAMES the stance)
//   "You assume an evasive stance."
//   "You begin to change your invocation."      (transition begins, unnamed)
//   "You begin reciting the recovery invocation."   (names the invocation)
//   "You begin reciting the empowering invocation."
//
// Inherent log limitation: the log only shows CHANGES, so the current
// stance/invocation is unknown until the first change after the app starts
// (rendered as "—"). Death/zone semantics are unverified — values are kept.

export interface StanceState {
  /** Current stance name ("striker"), or null = not seen yet. */
  stance: string | null;
  /** A stance change has begun and no completion line has arrived yet. */
  stanceChanging: boolean;
  /** Current invocation name ("recovery"), or null = not seen yet. */
  invocation: string | null;
  /** An invocation change has begun; cleared by the next reciting line. */
  invocationChanging: boolean;
}

export const EMPTY_STANCE_STATE: StanceState = {
  stance: null,
  stanceChanging: false,
  invocation: null,
  invocationChanging: false,
};

const ASSUME_RE = /^You assume (?:an? |the )?(.+) stance\.$/;
const RECITE_RE = /^You begin reciting the (.+) invocation\.$/;

/**
 * Fold one log message into the state. Returns the next state when the line
 * affects stance/invocation, or null when it does not (caller skips a
 * re-render).
 */
export function applyStanceLine(
  state: StanceState,
  message: string,
): StanceState | null {
  const assume = ASSUME_RE.exec(message);
  if (assume) {
    return { ...state, stance: assume[1], stanceChanging: false };
  }
  if (message === "You begin to change your stance.") {
    return { ...state, stanceChanging: true };
  }
  const recite = RECITE_RE.exec(message);
  if (recite) {
    return { ...state, invocation: recite[1], invocationChanging: false };
  }
  if (message === "You begin to change your invocation.") {
    return { ...state, invocationChanging: true };
  }
  return null;
}
