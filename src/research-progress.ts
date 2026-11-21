import type { Scalar } from './schema.ts';

export const researchPhases = ['identify', 'evidence', 'model', 'check', 'simulate'] as const;
export type ResearchPhase = typeof researchPhases[number];

export type ResearchProgress = {
  phase: ResearchPhase;
  detail: string;
  sources?: { title: string; url: string }[];
  terms?: string[];
  dossier?: { start: string; end: string; interpretation: string; context: number; heldOut: number };
  simulation?: { actors: string[]; branches: string[]; scenarios: number; rounds: number; runs: number };
  round?: { branch: string; step: number; actions: { actor?: string; rule: string; field: string; before: Scalar; after: Scalar }[] };
};
