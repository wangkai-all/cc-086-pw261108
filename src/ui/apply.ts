import type { Notice, OpResult } from "../domain/engine";
import type { TrackerState } from "../domain/types";
import type { SessionState } from "./store";

export function applyResult(
  session: SessionState,
  result: OpResult,
  nonce: number,
): SessionState {
  if (result.notice.level === "error") {
    return { ...session, toast: { ...result.notice, nonce } };
  }
  return {
    ...session,
    tracker: result.state,
    toast: { ...result.notice, nonce },
  };
}
