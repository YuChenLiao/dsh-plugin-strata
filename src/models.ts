/**
 * `/v1/models` 的读取与就绪判定。
 *
 * 交接文档 3.2 实测的响应：模型项带 `status.value`，模型**完全加载后**才是
 * `"loaded"`；加载期间端点连不上（不是故障，35B 权重要 47–61 秒）。因此
 * `status.value === "loaded"` 就是本插件的就绪探针（同文档 5.3 的建议）。
 *
 * @module dsh-plugin-strata/models
 */

import { StrataError } from './host.ts'

/** `/v1/models` 里的一项。 */
export interface StrataModelEntry {
  /** 服务报出的模型 id。 */
  id: string
  /** 加载状态；`loaded` 表示可立即接受请求。 */
  status?: { value?: string }
  /** 服务自述的上下文容量（实测字段 `n_ctx`）。 */
  meta?: { n_ctx?: number }
}

/** `/v1/models` 的响应体。 */
export interface StrataListing {
  data?: StrataModelEntry[]
}

/**
 * 解析 `/v1/models` 的响应体。
 * @param body - 已解析的 JSON（未校验形状的任意值）。
 * @returns 模型条目列表；形状不可识别时为**空数组**（"没有模型"比"编一个模型"安全）。
 */
export function readListing(body: unknown): StrataModelEntry[] {
  if (typeof body !== 'object' || body === null) return []
  const data = (body as StrataListing).data
  if (!Array.isArray(data)) return []
  return data.filter((entry): entry is StrataModelEntry =>
    typeof entry === 'object' && entry !== null && typeof (entry as StrataModelEntry).id === 'string')
}

/**
 * 列表里是否有已加载完成的模型。
 * @param entries - `/v1/models` 的条目。
 * @returns 至少一项处于 `loaded`。
 */
export function isLoaded(entries: readonly StrataModelEntry[]): boolean {
  return entries.some(entry => entry.status?.value === 'loaded')
}

/**
 * 请求一次模型列表。
 * @param baseURL - OpenAI 兼容基址（形如 `http://127.0.0.1:8080/v1`）。
 * @param headers - 额外请求头（归因头与凭据由调用方组装）。
 * @param signal - 取消信号；探测不应无限期挂住。
 * @returns 服务报出的模型条目。
 * @throws StrataError 端点不可达或返回非 2xx。
 */
export async function fetchListing(
  baseURL: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<StrataModelEntry[]> {
  let response: Response
  try {
    response = await fetch(`${baseURL}/models`, { method: 'GET', headers, ...signal === undefined ? {} : { signal } })
  } catch (error) {
    throw new StrataError(`strata: 无法连接 ${baseURL}（${describe(error)}）`, 'TRANSPORT', { cause: error })
  }
  if (!response.ok) {
    throw new StrataError(`strata: GET /models 返回 HTTP ${response.status}`, 'HTTP_STATUS', { status: response.status })
  }
  return readListing(await response.json())
}

/**
 * 把任意异常渲染成一行可读文本。
 * @param error - 捕获到的异常。
 * @returns 错误消息；空消息回落到异常名。
 */
export function describe(error: unknown): string {
  if (error instanceof Error) return error.message.length > 0 ? error.message : error.name
  return String(error)
}
