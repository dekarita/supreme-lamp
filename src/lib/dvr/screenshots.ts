// html2canvas is an actual DOM rasterizer (canvas.drawImage cannot draw arbitrary
// HTML). Only called after explicit full-DVR consent. No remote image loading.
export async function captureThumbnail(root: HTMLElement): Promise<string | null> {
  if (!root.isConnected) return null;
  const { default: html2canvas } = await import("html2canvas");
  const canvas = await html2canvas(root, {
    scale: Math.min(window.devicePixelRatio || 1, 2),
    useCORS: false, allowTaint: false, imageTimeout: 0, logging: false,
    ignoreElements: (el) => el.matches('input, textarea, select, [contenteditable], [data-dvr-private], [data-testid^="dvr-"], script, style') ||
      !!el.closest('[data-dvr-private]'),
    onclone: (doc) => {
      // html2canvas clones the document: mask sensitive descendants in the clone
      // even when a CSS background/label might otherwise draw them.
      doc.querySelectorAll('input, textarea, select, [contenteditable], [data-dvr-private]').forEach((el) => el.remove());
    },
  });
  const thumb = document.createElement("canvas");
  thumb.width = 320;
  thumb.height = 240;
  const ctx = thumb.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#111827";
  ctx.fillRect(0, 0, 320, 240);
  // Fit whole root in the thumbnail; never capture outside it.
  const ratio = Math.min(320 / canvas.width, 240 / canvas.height);
  ctx.drawImage(canvas, 0, 0, canvas.width * ratio, canvas.height * ratio);
  return thumb.toDataURL("image/png");
}
