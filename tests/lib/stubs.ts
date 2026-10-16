/**
 * 测试共用桩：一个状态可切换的本地服务（模拟"加载中 → 已加载"）与一个假进程拉起器。
 *
 * 放在 `lib/` 而不是 `*.test.ts`，因此不会被 `--test` 当作用例收集，只作为模块被引用。
 */
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { ProcessSpawner } from '../../src/serve.ts'

/** 可切换状态的桩服务：`loaded=false` 时表现成"模型还在加载"。 */
export interface StubService {
  baseURL: string
  loaded: boolean
  /** 收到的 `/models` 探测次数。 */
  probes: number
  close: () => Promise<void>
}

/** 服务就绪时 `/v1/models` 的响应体（字段取自交接文档 3.2 的实测形状）。 */
export const LOADED_LISTING = {
  object: 'list',
  data: [{
    id: 'qwen3.6-35b-a3b-ud-q4_k_xl',
    object: 'model',
    status: { value: 'loaded' },
    meta: { n_ctx: 65536 },
  }],
}

/**
 * 起一个桩服务。
 * @param loaded - 初始是否已加载完成。
 * @returns 可切换状态的服务桩。
 */
export async function startStub(loaded = false): Promise<StubService> {
  const state: StubService = {
    baseURL: '',
    loaded,
    probes: 0,
    close: () => Promise.resolve(),
  }
  const server: Server = createServer((request, response) => {
    if (request.url?.endsWith('/models') === true) {
      state.probes += 1
      if (!state.loaded) {
        // 加载期间端点连不上或直接报错；两种表现对托管器都等价于"还没好"。
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end('{"error":"still loading"}')
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(LOADED_LISTING))
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  state.baseURL = `http://127.0.0.1:${port}/v1`
  state.close = () => new Promise<void>((resolve, reject) => {
    server.close(error => (error === undefined ? resolve() : reject(error)))
  })
  return state
}

/** 假进程拉起器：记录拉起的 spec 与终止次数，不真的开进程。 */
export interface FakeSpawner {
  spawner: ProcessSpawner
  /** 每次 spawn 的完整 spec。 */
  spawned: SubprocessSpawnSpec[]
  /** 被 terminate 的进程序号（1 起）。 */
  terminated: number[]
}

/**
 * 造一个假进程拉起器。
 * @param service - 给了它，就在每次拉起后 5 毫秒把服务标成已加载，模拟"进程起来之后
 *   服务才开始加载"；不给则服务永远不会自己就绪（用来测超时）。
 * @returns 拉起器与它的观测记录。
 */
export function fakeSpawner(service?: StubService): FakeSpawner {
  const spawned: SubprocessSpawnSpec[] = []
  const terminated: number[] = []
  return {
    spawned,
    terminated,
    spawner: {
      spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
        spawned.push(spec)
        const index = spawned.length
        if (service !== undefined) {
          setTimeout(() => { service.loaded = true }, 5)
        }
        return {
          stdin: undefined,
          stdout: undefined,
          stderr: undefined,
          collected: {},
          // 常驻进程：永不 settle，直到有人 terminate。
          done: new Promise<never>(() => {}),
          terminate: () => { terminated.push(index) },
          waitForExit: () => Promise.resolve(true),
        } as unknown as SubprocessHandle
      },
    },
  }
}
