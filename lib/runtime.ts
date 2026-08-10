import type { Project, ProjectType, RuntimeProfile } from './types.ts';

/**
 * Buckets the gallery filters by. These follow what a template actually runs on, unlike the
 * legacy `type`, which folded every build-tool project into "react".
 */
export type RuntimeBucket = 'html' | 'vite' | 'react' | 'nextjs' | 'other';

const BUCKET_FOR_RUNTIME: Record<RuntimeProfile, RuntimeBucket> = {
  html: 'html',
  'vite-vanilla': 'vite',
  'vite-react': 'react',
  cra: 'react',
  nextjs: 'nextjs',
  unsupported: 'other',
};

/** Fallback for entries published before runtimes were recorded. */
const BUCKET_FOR_LEGACY_TYPE: Record<ProjectType, RuntimeBucket> = {
  html: 'html',
  nextjs: 'nextjs',
  react: 'other',
};

export const BUCKET_LABEL: Record<RuntimeBucket, string> = {
  html: 'HTML',
  vite: 'Vite',
  react: 'React',
  nextjs: 'Next.js',
  other: 'Khác',
};

/** Sort weight, cheapest runtime first, so "sort by type" reads as a build-complexity ramp. */
export const BUCKET_ORDER: Record<RuntimeBucket, number> = {
  html: 1,
  vite: 2,
  react: 3,
  nextjs: 4,
  other: 5,
};

export function runtimeBucket(project: Pick<Project, 'type' | 'runtime'>): RuntimeBucket {
  const runtime = project.runtime;
  if (runtime && runtime in BUCKET_FOR_RUNTIME) return BUCKET_FOR_RUNTIME[runtime];
  return BUCKET_FOR_LEGACY_TYPE[project.type] ?? 'other';
}

export function runtimeLabel(project: Pick<Project, 'type' | 'runtime'>): string {
  return BUCKET_LABEL[runtimeBucket(project)];
}

export function runtimeBucketCounts(projects: Array<Pick<Project, 'type' | 'runtime'>>): Record<RuntimeBucket, number> {
  const counts: Record<RuntimeBucket, number> = { html: 0, vite: 0, react: 0, nextjs: 0, other: 0 };
  for (const project of projects) counts[runtimeBucket(project)] += 1;
  return counts;
}
