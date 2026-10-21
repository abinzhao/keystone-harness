import { contentHash } from "@keystone/schemas";
import { rejectSecrets, sharedInputSchema, type SharedInput } from "./signatures.ts";

export interface LocalStatement { readonly id: string; readonly key: string; readonly statement: string }
export interface ImportedCandidate extends SharedInput {
  readonly candidateId: string; readonly status: "imported_candidate"; readonly trustLevel: "untrusted";
  readonly conflicts: readonly string[];
}

export function importCandidate(input: SharedInput, local: readonly LocalStatement[]): ImportedCandidate {
  rejectSecrets(input);
  const parsed = sharedInputSchema.parse(input);
  return {
    ...parsed, candidateId: `candidate.${contentHash(parsed)}`,
    status: "imported_candidate", trustLevel: "untrusted",
    conflicts: local.filter((entry) => entry.key === parsed.key && entry.statement !== parsed.statement).map((entry) => entry.id).sort(),
  };
}
