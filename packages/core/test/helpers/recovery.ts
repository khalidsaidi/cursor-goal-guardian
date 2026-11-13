import { submitGoalReport, type GoalReportInput } from "../../src/index.js";

/** Existing proof/engine tests use non-git fixtures where independent review cannot run.
 * Exercise the bounded retry so those tests can assert the eventual result. Recovery behavior
 * itself is tested using the raw API and faulting subprocesses in decides.test.ts. */
export async function finishReport(root: string, input: GoalReportInput) {
  const answer = await submitGoalReport(root, input);
  return answer.verificationPending ? submitGoalReport(root, input) : answer;
}
