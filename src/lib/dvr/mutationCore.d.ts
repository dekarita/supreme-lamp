// [F107 §2] Types for the mutation descriptor core (src/lib/dvr/mutationCore.js).
// Hand-written, like ../dvr-core.d.ts: the implementation is plain JS so the
// Node gate can import and exercise it with no DOM and no build step.

export declare const MUTATION_KINDS: string[];
export declare const MUTATION_BATCH_CAP: number;
export declare const MUTATION_SESSION_CAP: number;

/** Minimal MutationRecord shape this core accepts (structural fields only -
 *  content fields are never read, by design). */
export interface MutationRecordLike {
  type: string;
  target: { nodeName?: string } | null;
  addedNodes?: { length: number };
  removedNodes?: { length: number };
  attributeName?: string | null;
}

/** One mutation descriptor. Tag name + attribute NAME + counts; never values. */
export interface MutationDescriptor {
  at: number;
  type: "childList" | "attributes" | "characterData";
  target: string;
  added?: number;
  removed?: number;
  attr?: string;
  folded?: number;
}

export interface RecordMutationsOptions {
  now?: number;
  batchCap?: number;
}

export interface MutationBufferOptions {
  sessionCap?: number;
}

export declare function recordMutations(records: MutationRecordLike[], opts?: RecordMutationsOptions): MutationDescriptor[];
export declare function appendMutations(buffer: MutationDescriptor[], descriptors: MutationDescriptor[], opts?: MutationBufferOptions): MutationDescriptor[];
export declare function serializeMutations(list: MutationDescriptor[]): string;
export declare function deserializeMutations(text: string): MutationDescriptor[] | null;
export declare function mutationStats(list: MutationDescriptor[]): { count: number; byType: Record<string, number> };
