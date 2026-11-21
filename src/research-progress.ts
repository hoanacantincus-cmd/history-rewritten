export const researchPhases = ['identify', 'evidence', 'model', 'check'] as const;
export type ResearchPhase = typeof researchPhases[number];

export type ResearchProgress = {
  phase: ResearchPhase;
  detail: string;
  sources?: { title: string; url: string }[];
};
