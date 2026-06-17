export type ProjectType = 'html' | 'react' | 'nextjs';

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
  media?: { images: MediaFile[]; videos: MediaFile[]; zips: MediaFile[] };
}

export interface IndexData {
  generatedAt: string;
  counts: Partial<Record<ProjectType, number>>;
  projects: Project[];
}
