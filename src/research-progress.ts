export const researchPhases = ['identify', 'evidence', 'model', 'check', 'simulate'] as const;
export type ResearchPhase = typeof researchPhases[number];

export type ResearchProgress = {
  phase: ResearchPhase;
  detail: string;
  sources?: { title: string; url: string }[];
  terms?: string[];
  simulation?: { actors: string[]; branches: string[]; scenarios: number; rounds: number; runs: number };
};
