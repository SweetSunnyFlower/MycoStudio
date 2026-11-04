import { api } from "@/lib/api";
import type { AiProviders } from "./types";

/**
 * 供应商配置只在应用启动后变一次（用户去设置里改），但「刚打开 AI 抽屉就发问」
 * 时异步读取还没回来，会被误判成「没配供应商」。
 * 这里缓存上次的结果：打开抽屉时先用缓存同步判断，再后台刷新一次。
 */
let last: AiProviders | null = null;
let inflight: Promise<AiProviders> | null = null;

/** 上次读到的配置（可能为 null，表示还没读过） */
export function cachedAiProviders(): AiProviders | null {
  return last;
}

/** 读配置：并发调用共用同一个请求；force 时强制重新读 */
export function loadAiProviders(force = false): Promise<AiProviders> {
  if (!force && inflight) return inflight;
  const req = api
    .listAiProviders()
    .then((data) => {
      last = data;
      inflight = null;
      return data;
    })
    .catch((e) => {
      inflight = null;
      throw e;
    });
  inflight = req;
  return req;
}

/** 命令已经返回了最新配置时，直接拿来更新缓存，省一次读取 */
export function primeAiProviders(data: AiProviders) {
  last = data;
  inflight = null;
}
