/**
 * 安装自动检测的契约测试。
 *
 * 全部跑在假文件系统上：检测规则要能在没有 Strata 的机器上被验证，也必须能证明
 * "不像安装的目录不会被误认"。真实磁盘的那一路由 live 用例覆盖。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  STRATA_UPSTREAM,
  candidateRoots,
  detectInstallation,
  missingInstallationHint,
} from '../src/detect.ts'
import type { DetectFs } from '../src/detect.ts'

/** 假文件树：目录 → 条目名，文件 → 内容。 */
interface FakeTree {
  dirs: Record<string, string[]>
  files: Record<string, string>
}

/** 把假文件树包成检测需要的文件系统视图。 */
function treeFs(tree: FakeTree): DetectFs {
  return {
    exists: path => Object.hasOwn(tree.files, path) || Object.hasOwn(tree.dirs, path),
    list: dir => tree.dirs[dir] ?? [],
    readJson: (path) => {
      const body = tree.files[path]
      if (body === undefined) throw new Error(`no such file: ${path}`)
      return JSON.parse(body)
    },
  }
}

/** 一个装好的 Strata 根目录。 */
function installedRoot(root: string, configs: Record<string, unknown> = {}): FakeTree {
  const tree: FakeTree = {
    dirs: { [root]: ['serve', 'engine', '.venv', ...Object.keys(configs)] },
    files: {
      [`${root}\\serve\\server.py`]: '',
      [`${root}\\engine\\strata.exe`]: '',
    },
  }
  for (const [name, body] of Object.entries(configs)) {
    tree.files[`${root}\\${name}`] = JSON.stringify(body)
  }
  return tree
}

test('STRATA_HOME 指向的安装被找到，端口与模型来自引擎配置', () => {
  const root = 'C:\\Strata'
  const tree = installedRoot(root, {
    'strata-qwen36-ud-q4_k_xl.json': { port: 8080, model_name: 'qwen3.6-35b-a3b-ud-q4_k_xl' },
  })
  const install = detectInstallation({ fs: treeFs(tree), env: { STRATA_HOME: root } })
  assert.ok(install !== undefined)
  assert.equal(install.root, root)
  assert.equal(install.serverScript, `${root}\\serve\\server.py`)
  assert.equal(install.python, 'python', '没有虚拟环境时交给 PATH 上的 python')
  assert.equal(install.engineConfig, `${root}\\strata-qwen36-ud-q4_k_xl.json`)
  assert.equal(install.port, 8080)
  assert.equal(install.model, 'qwen3.6-35b-a3b-ud-q4_k_xl')
  assert.equal(install.source, 'env')
})

test('装了虚拟环境就用它，不再依赖 PATH', () => {
  const root = 'C:\\Strata'
  const tree = installedRoot(root, { 'strata-qwen.json': { port: 8081 } })
  tree.files[`${root}\\.venv\\Scripts\\python.exe`] = ''
  const install = detectInstallation({ fs: treeFs(tree), env: { STRATA_HOME: root } })
  assert.equal(install?.python, `${root}\\.venv\\Scripts\\python.exe`)
})

test('常见安装位置也会被找到，并标出来源', () => {
  const root = 'C:\\Users\\tester\\Strata'
  const tree = installedRoot(root, { 'strata-qwen.json': { port: 8080 } })
  const install = detectInstallation({ fs: treeFs(tree), env: { USERPROFILE: 'C:\\Users\\tester' } })
  assert.equal(install?.root, root)
  assert.equal(install?.source, 'common-path')
})

test('只有 server.py、既没引擎也没虚拟环境的目录不算安装', () => {
  const root = 'D:\\NotStrata'
  const tree: FakeTree = {
    dirs: { [root]: ['serve'] },
    files: { [`${root}\\serve\\server.py`]: '' },
  }
  assert.equal(detectInstallation({ fs: treeFs(tree), env: { STRATA_HOME: root } }), undefined)
})

test('没有任何候选命中时返回 undefined，不做猜测', () => {
  const tree: FakeTree = { dirs: {}, files: {} }
  assert.equal(detectInstallation({ fs: treeFs(tree), env: {} }), undefined)
})

test('.bak 之类的备份配置不会被当成现用配置', () => {
  const root = 'C:\\Strata'
  const tree = installedRoot(root, { 'strata-old.json.bak': { port: 9999 } })
  const install = detectInstallation({ fs: treeFs(tree), env: { STRATA_HOME: root } })
  assert.ok(install !== undefined)
  assert.equal(install.engineConfig, undefined, '没有可用配置时仍能启动（--engine 就够了）')
  assert.equal(install.port, undefined)
})

test('多份引擎配置时按期望模型挑，其次按端口挑', () => {
  const root = 'C:\\Strata'
  const tree = installedRoot(root, {
    'strata-a.json': { port: 8080, model_name: 'model-a' },
    'strata-b.json': { port: 9090, model_name: 'model-b' },
  })
  const byModel = detectInstallation({ fs: treeFs(tree), env: { STRATA_HOME: root }, model: 'model-b' })
  assert.equal(byModel?.engineConfig, `${root}\\strata-b.json`)
  const byPort = detectInstallation({ fs: treeFs(tree), env: { STRATA_HOME: root }, port: 8080 })
  assert.equal(byPort?.engineConfig, `${root}\\strata-a.json`)
})

test('坏掉的配置被跳过，后面的候选仍然能用', () => {
  const root = 'C:\\Strata'
  const tree: FakeTree = {
    dirs: { [root]: ['serve', 'engine', 'strata-bad.json'] },
    files: {
      [`${root}\\serve\\server.py`]: '',
      [`${root}\\engine\\strata.exe`]: '',
      [`${root}\\strata-bad.json`]: '{ this is not json',
    },
  }
  const install = detectInstallation({ fs: treeFs(tree), env: { STRATA_HOME: root } })
  assert.ok(install !== undefined, '配置坏掉不影响"这是一处安装"的判断')
  assert.equal(install.port, undefined)
})

test('用户给了完整启动命令就不检测', () => {
  const root = 'C:\\Strata'
  const tree = installedRoot(root, { 'strata-qwen.json': { port: 8080 } })
  const install = detectInstallation({
    fs: treeFs(tree),
    env: { STRATA_HOME: root },
    explicitCommand: ['C:\\custom\\run.exe'],
  })
  assert.equal(install, undefined)
})

test('候选目录按优先级排列且去重', () => {
  const roots = candidateRoots({
    STRATA_HOME: 'E:\\MyStrata',
    USERPROFILE: 'C:\\Users\\tester',
    LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
  })
  assert.equal(roots[0], 'E:\\MyStrata', '环境变量优先')
  assert.ok(roots.includes('C:\\Users\\tester\\Strata'))
  assert.ok(roots.includes('C:\\Users\\tester\\AppData\\Local\\Strata'))
  assert.equal(new Set(roots.map(root => root.toLowerCase())).size, roots.length, '不应有重复')
})

test('找不到安装时的说明里带上游地址与判定条件', () => {
  const hint = missingInstallationHint()
  assert.match(hint, new RegExp(STRATA_UPSTREAM.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(hint, /serve\/server\.py/)
  assert.match(hint, /serveCommand/)
})
