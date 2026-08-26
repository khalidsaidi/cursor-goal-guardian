import { z } from "zod";

export const successCriterionSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
  })
  .strict();

export const contractSchema = z
  .object({
    schemaVersion: z.literal(2),
    goal: z.string(),
    successCriteria: z.array(successCriterionSchema),
    constraints: z.array(z.string()),
  })
  .strict();

export type SuccessCriterion = z.infer<typeof successCriterionSchema>;
export type Contract = z.infer<typeof contractSchema>;

export function parseContract(value: unknown): Contract {
  return contractSchema.parse(value);
}

export function defaultContract(): Contract {
  return {
    schemaVersion: 2,
    goal: "",
    successCriteria: [],
    constraints: [],
  };
}

/** Generate stable sc_1..sc_n criterion ids for plain criterion texts. */
export function criteriaFromTexts(texts: string[]): SuccessCriterion[] {
  return texts.map((text, i) => ({ id: `sc_${i + 1}`, text }));
}
