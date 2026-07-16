import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(process.cwd(), 'scripts', 'otel-debug-collector.mjs')

describe('otel-debug-collector.mjs', () => {
  let proc: ChildProcess | null = null
  let dir: string

  afterEach(() => {
    proc?.kill()
    proc = null
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  function waitForListening(child: ChildProcess): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for collector to start')), 5000)
      child.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('で待ち受け中')) {
          clearTimeout(timeout)
          resolve()
        }
      })
      child.on('error', reject)
    })
  }

  it('writes received metrics to a date-rotated file under the log dir', async () => {
    dir = mkdtempSync(join(tmpdir(), 'otel-collector-'))
    const port = 14318 + Math.floor(Math.random() * 1000)
    const logDir = join(dir, 'otel')

    proc = spawn('node', [SCRIPT], {
      env: {
        ...process.env,
        OTEL_DEBUG_COLLECTOR_PORT: String(port),
        OTEL_DEBUG_COLLECTOR_LOG_DIR: logDir,
      },
    })
    await waitForListening(proc)

    const res = await fetch(`http://localhost:${port}/v1/metrics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'claude_code.cost.usage' }] }] }] }),
    })
    expect(res.status).toBe(200)

    // サーバがファイルへの書き込みを終えるまで少し待つ
    await new Promise(r => setTimeout(r, 200))

    const files = readdirSync(logDir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/)

    const content = readFileSync(join(logDir, files[0]), 'utf-8')
    expect(content).toContain('claude_code.cost.usage')
    expect(content).toContain('/v1/metrics')
  })

  it('prunes log files older than the retention period on startup', async () => {
    dir = mkdtempSync(join(tmpdir(), 'otel-collector-retention-'))
    const port = 15318 + Math.floor(Math.random() * 1000)
    const logDir = join(dir, 'otel')

    // 事前に古いログファイルと新しいログファイルを用意する
    const fs = await import('node:fs')
    fs.mkdirSync(logDir, { recursive: true })
    const oldFile = join(logDir, '2000-01-01.jsonl')
    const recentFile = join(logDir, '2099-01-01.jsonl')
    writeFileSync(oldFile, '{}\n')
    writeFileSync(recentFile, '{}\n')
    const veryOld = new Date('2000-01-01').getTime() / 1000
    utimesSync(oldFile, veryOld, veryOld)

    proc = spawn('node', [SCRIPT], {
      env: {
        ...process.env,
        OTEL_DEBUG_COLLECTOR_PORT: String(port),
        OTEL_DEBUG_COLLECTOR_LOG_DIR: logDir,
        OTEL_DEBUG_COLLECTOR_RETENTION_DAYS: '30',
      },
    })
    await waitForListening(proc)

    const files = readdirSync(logDir)
    expect(files).not.toContain('2000-01-01.jsonl')
    expect(files).toContain('2099-01-01.jsonl')
  })
})
