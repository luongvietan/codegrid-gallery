import { assetUrl } from './assets.ts';
import type { PreviewManifest, Project } from './types.ts';

export type PreviewKind = 'legacy-html' | 'static' | 'runtime-required' | 'none';
export type PreviewTab = 'preview' | 'code' | 'media';

export function needsSourceZip(tab: PreviewTab, kind: PreviewKind): boolean {
  return tab === 'code' || (tab === 'preview' && (kind === 'legacy-html' || kind === 'runtime-required'));
}

export function previewKind(
  project: Pick<Project, 'type' | 'entryHtml' | 'preview'>,
): PreviewKind {
  if (
    project.preview?.mode === 'static'
    && project.preview.status === 'ready'
    && project.preview.sourceHash
    && project.preview.entry
  ) {
    return 'static';
  }

  if (project.entryHtml) return 'legacy-html';
  if (project.type === 'react' || project.type === 'nextjs') return 'runtime-required';
  return 'none';
}

export function hasReadyPreview(project: Pick<Project, 'type' | 'entryHtml' | 'preview'>): boolean {
  const kind = previewKind(project);
  return kind === 'static' || kind === 'legacy-html';
}

export function hasPreviewTab(project: Pick<Project, 'type' | 'entryHtml' | 'preview'>): boolean {
  return previewKind(project) !== 'none';
}

export function staticPreviewUrl(preview: Pick<PreviewManifest, 'sourceHash' | 'entry'>): string {
  if (!preview.sourceHash || !preview.entry) throw new Error('Static preview manifest is incomplete');
  return assetUrl(`previews/${preview.sourceHash}`, preview.entry);
}
