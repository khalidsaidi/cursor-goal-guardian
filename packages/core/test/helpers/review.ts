/** Explicit verification supplied by reviewer stand-ins; no real model or project build is run by these fakes. */
export const VERIFIED_CHECKS = [
  { id: "build", verdict: "holds", evidence: "stand-in checked the build" },
  { id: "public_api", verdict: "holds", evidence: "stand-in checked public entry points" },
  { id: "behavior", verdict: "holds", evidence: "stand-in checked requested behavior" },
];
export const checkedReview = (review: unknown) => ({ ...(review as object), checks: VERIFIED_CHECKS });
