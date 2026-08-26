export type StateErrorCode =
  | "TASK_NOT_FOUND"
  | "QUESTION_NOT_FOUND"
  | "DECISION_REQUIRED"
  | "TODO_TO_DONE"
  | "INVALID_PAYLOAD"
  | "MANUAL_EDIT"
  | "CORRUPT_ACTION_LOG";

export class StateError extends Error {
  readonly code: StateErrorCode;

  constructor(code: StateErrorCode, message: string) {
    super(message);
    this.name = "StateError";
    this.code = code;
  }
}
