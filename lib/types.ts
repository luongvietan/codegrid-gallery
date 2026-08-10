export type ProjectType = 'html' | 'react' | 'nextjs';

export type RuntimeProfile = 'html' | 'vite-vanilla' | 'vite-react' | 'cra' | 'nextjs' | 'unsupported';
export type PreviewMode = 'html' | 'static' | 'webcontainer' | 'vercel' | 'unavailable';
export type PreviewStatus = 'ready' | 'build-failed' | 'runtime-required' | 'unsupported';

export interface PreviewManifest {
  mode: PreviewMode;
  runtime: RuntimeProfile;
  sourceHash: string | null;
  artifactBase: string | null;
  entry: string | null;
  status: PreviewStatus;
  builderVersion: number;
  failureCode: string | null;
}

export interface MediaFile { filename?: string; size?: number; url?: string; }

export interface Project {
  id: string;
  folder: string;
  title: string;
  type: ProjectType;
  date: string | null;
  author: string | null;
  msgId: string | null;
  thumbnail: string | null;
  video: string | null;
  zip: string;
  entryHtml: string | null;
  runtime?: RuntimeProfile;
  preview?: PreviewManifest;
  media?: { images: MediaFile[]; videos: MediaFile[]; zips: MediaFile[] };
}

export interface IndexData {
  generatedAt: string;
  counts: Partial<Record<ProjectType, number>>;
  projects: Project[];
}
