import data from '@/data/index.json';
import type { IndexData } from '@/lib/types';
import Gallery from '@/components/Gallery';

export default function Page() {
  return <Gallery data={data as unknown as IndexData} />;
}
