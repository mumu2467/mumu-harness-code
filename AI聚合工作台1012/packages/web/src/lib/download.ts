/**
 * 浏览器端下载工具：把字符串/Blob 存成文件。
 * 集中在这里，避免导出/截图等多处重复写 a[download] 的逻辑。
 */
export function downloadText(filename: string, content: string, mime = 'text/plain;charset=utf-8'): void {
  downloadBlob(filename, new Blob([content], { type: mime }));
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  window.setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}

/** 生成文件名里的时间戳：20261012-0040 */
export function fileStamp(ts = Date.now()): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
