let SW: ServiceWorker | null = null;

export async function initSW(onWarn: (msg: string) => void): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    onWarn('Trình duyệt không hỗ trợ Service Worker → preview HTML sẽ không chạy.');
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    SW = reg.active || reg.installing || reg.waiting;
  } catch (e) {
    onWarn('Không đăng ký được Service Worker (' + (e as Error).message + ')');
  }
}

export function swSend(msg: unknown, transfer: Transferable[] = []): Promise<any> {
  return new Promise((resolve, reject) => {
    const sw = navigator.serviceWorker.controller || SW;
    if (!sw) return reject(new Error('SW chưa sẵn sàng'));
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => resolve(e.data);
    sw.postMessage(msg, [ch.port2, ...transfer]);
  });
}
