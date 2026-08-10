'use client';

import type { ProjectType } from '@/lib/types';

const MESSAGE: Record<Exclude<ProjectType, 'html'>, string> = {
  react: 'Template React này chưa có HTML entry hoặc artifact tĩnh để hiển thị. Hãy mở Code để xem source.',
  nextjs: 'Template Next.js cần runtime server. Preview sẽ xuất hiện tại đây khi có artifact tương thích.',
};

export default function RuntimePreviewTab({ type }: { type: Exclude<ProjectType, 'html'> }) {
  return (
    <section className="pane pane-preview active">
      <div className="preview-toolbar">
        <span className="status">runtime-required</span>
      </div>
      <div className="spinner no-spin">{MESSAGE[type]}</div>
    </section>
  );
}
