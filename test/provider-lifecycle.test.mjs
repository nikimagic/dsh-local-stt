/** Lifecycle regressions: no servers, all probes/processes are mocks. */
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HttpSpeechProvider } from '../index.js'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-provider-lifecycle-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const provider = new HttpSpeechProvider({ logger: { warn() {} } }, {
    kind: 'whisper', label: 'Mock ASR', modelPath: join(dir, 'model.bin'),
    primaryName: 'model.bin', modelSpec: { estimate: {}, files: [] },
    info: { id: 'mock', name: 'Mock', languages: ['ru'] },
    command: process.execPath, port: '12345', autoStart: true,
    startupTimeoutMs: 10_000, requestTimeoutMs: 1_000,
    baseUrl: 'http://127.0.0.1:1', healthPath: '/health', transcribePath: '/transcribe',
    model: 'mock', startHint: 'mock',
  })
  provider.pidFile = join(dir, 'server.pid')
  provider.preflight = () => {}
  provider.engineReady = () => true
  provider.missingFiles = () => []
  provider.probe = async () => { throw new Error('unexpected probe') }
  provider.launch = async () => { throw new Error('unexpected launch') }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network') })
  return provider
}

const input = { audio: new Uint8Array(44), language: 'ru' }
const signal = () => new AbortController().signal

for (const action of ['dispose', 'cancel']) {
  for (const running of [false, true]) {
    test(`${action} during initial probe (${running}): no launch or POST after await`, { timeout: 3_000 }, async (t) => {
      const provider = fixture(t)
      const entered = deferred()
      const probe = deferred()
      let launches = 0
      provider.probe = () => { entered.resolve(); return probe.promise }
      provider.launch = async () => { launches++ }
      const request = provider.transcribe(input, signal())
      const rejected = assert.rejects(request, /disposed|отменена/)
      await entered.promise
      let finished = false
      const stopping = provider[action]().then(() => { finished = true })
      await Promise.resolve()
      assert.equal(finished, false, `${action} must wait for startup`)
      probe.resolve(running)
      await Promise.all([stopping, rejected])
      assert.equal(launches, 0)
      assert.equal(globalThis.fetch.mock.callCount(), 0)
      assert.equal(provider.active, null)
    })
  }

  test(`${action} during launch waits for late resource and cleans it`, { timeout: 3_000 }, async (t) => {
    const provider = fixture(t)
    const entered = deferred()
    const launch = deferred()
    provider.probe = async () => false
    provider.launch = async () => {
      entered.resolve()
      await launch.promise
      provider.ownedProcess = { pid: 12345, exitCode: 0 }
      provider.writePid(12345)
    }
    const request = provider.transcribe(input, signal())
    const rejected = assert.rejects(request, /disposed|отменена/)
    await entered.promise
    const stopping = provider[action]()
    launch.resolve()
    await Promise.all([stopping, rejected])
    assert.equal(provider.ownedProcess, null)
    assert.equal(existsSync(provider.pidFile), false)
    assert.equal(globalThis.fetch.mock.callCount(), 0)
  })
}

for (const action of ['dispose', 'cancel']) {
  test(`${action} during readiness probe cannot publish ready or POST`, { timeout: 4_000 }, async (t) => {
    const provider = fixture(t)
    const entered = deferred()
    const readiness = deferred()
    let probes = 0
    provider.probe = async () => {
      if (++probes === 1) return false
      entered.resolve()
      return readiness.promise
    }
    provider.launch = async () => {
      provider.ownedProcess = { pid: 12345, exitCode: 0 }
      provider.writePid(12345)
    }
    const phases = []
    provider.subscribe(() => phases.push(provider.state.phase))
    const request = provider.transcribe(input, signal())
    const rejected = assert.rejects(request, /disposed|отменена/)
    await entered.promise
    const stopping = provider[action]()
    readiness.resolve(true)
    await Promise.all([stopping, rejected])
    assert.equal(phases.includes('ready'), false)
    assert.equal(provider.ownedProcess, null)
    assert.equal(existsSync(provider.pidFile), false)
    assert.equal(globalThis.fetch.mock.callCount(), 0)
  })
}

test('dispose before queued task starts cannot start server', async (t) => {
  const provider = fixture(t)
  const request = provider.transcribe(input, signal())
  const rejected = assert.rejects(request, /disposed|остановлен/)
  await provider.dispose()
  await rejected
  assert.equal(provider.active, null)
})

test('cancel before active task microtask prevents startup', async (t) => {
  const provider = fixture(t)
  const request = provider.transcribe(input, signal())
  const rejected = assert.rejects(request, /отменена/)
  await provider.cancel()
  await rejected
})

test('dispose waits for active response/finally and repeated dispose shares completion', { timeout: 3_000 }, async (t) => {
  const provider = fixture(t)
  const entered = deferred()
  const body = deferred()
  provider.startServer = async () => {
    provider.ownedProcess = { pid: 12345, exitCode: 0 }
    provider.writePid(12345)
    return true
  }
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    text: () => { entered.resolve(); return body.promise },
  }))
  const request = provider.transcribe(input, signal())
  const rejected = assert.rejects(request, /disposed/)
  await entered.promise
  const first = provider.dispose()
  assert.equal(provider.dispose(), first)
  let finished = false
  first.then(() => { finished = true })
  await Promise.resolve()
  assert.equal(finished, false)
  body.resolve('{"text":"must not be returned"}')
  await Promise.all([first, rejected])
  assert.equal(provider.active, null)
  assert.equal(provider.ownedProcess, null)
  assert.equal(existsSync(provider.pidFile), false)
})

test('dispose waits for outstanding identity and cleanup resources', { timeout: 3_000 }, async (t) => {
  const provider = fixture(t)
  const cleanup = deferred()
  const identity = deferred()
  provider.cleanupPromise = cleanup.promise
  provider.identityTasks.add(identity.promise)
  let finished = false
  const disposing = provider.dispose().then(() => { finished = true })
  await Promise.resolve()
  assert.equal(finished, false)
  cleanup.resolve()
  await Promise.resolve()
  assert.equal(finished, false)
  identity.resolve()
  await disposing
  assert.equal(finished, true)
})

test('cancel after startup resolves but before continuation prevents POST', async (t) => {
  const provider = fixture(t)
  const startup = deferred()
  provider.startServer = () => startup.promise
  const request = provider.transcribe(input, signal())
  const rejected = assert.rejects(request, /отменена/)
  await Promise.resolve()
  startup.resolve(false)
  await provider.cancel()
  await rejected
  assert.equal(globalThis.fetch.mock.callCount(), 0)
})

test('stopOwned/dispose without owned child preserves foreign PID record', async (t) => {
  const provider = fixture(t)
  const foreign = JSON.stringify({ pid: 45678, ownerPid: 99999, createdAt: 'foreign' })
  writeFileSync(provider.pidFile, foreign)
  provider.clearPid()
  await provider.stopOwned()
  await provider.dispose()
  assert.equal(readFileSync(provider.pidFile, 'utf8'), foreign)
})

test('owned exited child removes own PID, but not a replacement even with same PID', async (t) => {
  const provider = fixture(t)
  provider.ownedProcess = { pid: 12345, exitCode: 0 }
  provider.writePid(12345)
  await provider.stopOwned()
  assert.equal(existsSync(provider.pidFile), false)
  provider.ownedProcess = { pid: 12345, exitCode: 0 }
  provider.writePid(12345)
  const foreign = JSON.stringify({ pid: 12345, ownerPid: 99999, createdAt: 'replacement' })
  writeFileSync(provider.pidFile, foreign)
  await provider.stopOwned()
  assert.equal(readFileSync(provider.pidFile, 'utf8'), foreign)
})

test('cleanupStale removes only the observed dead/invalid record', async (t) => {
  const provider = fixture(t)
  writeFileSync(provider.pidFile, '0')
  await provider.cleanupStale()
  assert.equal(existsSync(provider.pidFile), false)
  writeFileSync(provider.pidFile, '12345')
  t.mock.method(process, 'kill', () => { throw new Error('not alive') })
  await provider.cleanupStale()
  assert.equal(existsSync(provider.pidFile), false)
})

test('cleanupStale preserves replacement written while identity probe awaits', async (t) => {
  const provider = fixture(t)
  const old = JSON.stringify({ pid: 12345, createdAt: 'old' })
  const foreign = JSON.stringify({ pid: 12345, ownerPid: 99999, createdAt: 'new' })
  writeFileSync(provider.pidFile, old)
  t.mock.method(process, 'kill', () => true)
  const spawnMock = t.mock.method(childProcess, 'spawn', (command, args, options) => {
    assert.equal(command, 'powershell.exe', 'no real process or taskkill allowed')
    const child = new EventEmitter()
    queueMicrotask(() => {
      writeSync(options.stdio[1], JSON.stringify({ path: 'unrelated.exe', createdAt: 'old', portPid: 12345 }))
      writeFileSync(provider.pidFile, foreign)
      child.emit('exit', 0)
    })
    return child
  })
  syncBuiltinESMExports()
  t.after(() => { spawnMock.mock.restore(); syncBuiltinESMExports() })
  await provider.cleanupStale()
  assert.equal(readFileSync(provider.pidFile, 'utf8'), foreign)
})
