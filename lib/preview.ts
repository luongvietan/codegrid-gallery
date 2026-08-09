import { assetUrl } from './assets.ts';
import type { PreviewManifest, Project } from './types.ts';

export function previewKind(
  project: Pick<Project, 'type' | 'entryHtml' | 'preview'>,
): 'legacy-html' | 'static' | 'none' {
  if (
    project.preview?.mode === 'static'
    && project.preview.status === 'ready'
    && project.preview.sourceHash
    && project.preview.entry
  ) {
    return 'static';
  }

  if (project.type === 'html' && project.entryHtml) return 'legacy-html';
  return 'none';
}

export function hasReadyPreview(project: Pick<Project, 'type' | 'entryHtml' | 'preview'>): boolean {
  return previewKind(project) !== 'none';
}

export function staticPreviewUrl(preview: Pick<PreviewManifest, 'sourceHash' | 'entry'>): string {
  if (!preview.sourceHash || !preview.entry) throw new Error('Static preview manifest is incomplete');
  return assetUrl(`previews/${preview.sourceHash}`, preview.entry);
}
