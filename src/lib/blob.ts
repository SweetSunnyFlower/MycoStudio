import type { Value } from "@/lib/types";

/** 超过这个大小的二进制不做图片预览，避免把界面拖死 */
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

function bytesToBase64(bytes: number[]): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.slice(i, i + chunk));
  }
  return btoa(bin);
}

/** 按魔数判断是不是图片，是就返回可直接塞进 <img> 的 data URL */
export function imageDataUrl(v: Value): string | null {
  if (v.type !== "bytes") return null;
  const b = v.value;
  if (b.length < 4 || b.length > MAX_PREVIEW_BYTES) return null;

  let mime: string | null = null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) mime = "image/png";
  else if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) mime = "image/jpeg";
  else if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) mime = "image/gif";
  else if (b[0] === 0x42 && b[1] === 0x4d) mime = "image/bmp";
  else if (
    b.length > 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    mime = "image/webp";
  }
  if (!mime) return null;

  try {
    return `data:${mime};base64,${bytesToBase64(b)}`;
  } catch {
    return null;
  }
}
