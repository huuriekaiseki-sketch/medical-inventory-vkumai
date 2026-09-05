#!/usr/bin/env node
// issue #417向けのローカル検証用OTel collector。
// 本物のotel-collector/GrafanaはDocker等のインフラが必要なため、Dockerが無い環境でも
// 「tokens/costが実際にエクスポートされているか」を素早く確認できる最小限のOTLP/HTTP(json)
// 受信サーバ。本番運用でGrafana等を導入する場合は、このスクリプトの代わりに
// 実際のotel-collectorを立てて置き換えること。
//
// 使い方:
//   node scripts/otel-debug-collector.mjs
// .claude/settings.local.json 側で以下を設定しておくこと（settings.jsonには入れない。
// 他の開発者がcollectorを立てていない場合に毎回接続失敗ノイズが出るため）:
//   CLAUDE_CODE_ENABLE_TELEMETRY=1
//   OTEL_METRICS_EXPORTER=otlp
//   OTEL_LOGS_EXPORTER=otlp
//   OTEL_EXPORTER_OTLP_PROTOCOL=http/json
//   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
//
// 受信したリクエストは標準出力に要約を出し、生JSONは logs/otel/YYYY-MM-DD.jsonl に日付ローテーション
// して追記する（issue #430）。起動時に保持期間（既定30日、OTEL_DEBUG_COLLECTOR_RETENTION_DAYS
// で変更可）より古いログファイルを削除する。単一ファイルへの無限追記だと肥大化するのと、
// 「設定変更前のbaseline取得」を事後クエリにする（issue #419の教訓）には日付単位で参照できる
// 形が必要なため。

import http from 'node:http'
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const PORT = process.env.OTEL_DEBUG_COLLECTOR_PORT ?? 4318
const LOG_DIR = process.env.OTEL_DEBUG_COLLECTOR_LOG_DIR ?? 'logs/otel'
const RETENTION_DAYS = Number(process.env.OTEL_DEBUG_COLLECTOR_RETENTION_DAYS ?? 30)
mkdirSync(LOG_DIR, { recursive: true })

function currentLogFile() {
  const date = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  return join(LOG_DIR, `${date}.jsonl`)
}

function pruneOldLogs() {
  if (!(RETENTION_DAYS > 0)) return // 0以下は無効化（保持期間の管理をしない）
  const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
  let removed = 0
  for (const name of readdirSync(LOG_DIR)) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue
    const path = join(LOG_DIR, name)
    if (statSync(path).mtimeMs < cutoffMs) {
      unlinkSync(path)
      removed++
    }
  }
  if (removed > 0) {
    console.log(`otel-debug-collector: 保持期間（${RETENTION_DAYS}日）を過ぎたログファイルを${removed}件削除しました`)
  }
}

pruneOldLogs()

function summarizeMetrics(body) {
  const names = new Set()
  for (const rm of body.resourceMetrics ?? []) {
    for (const sm of rm.scopeMetrics ?? []) {
      for (const metric of sm.metrics ?? []) {
        if (metric?.name) names.add(metric.name)
      }
    }
  }
  return [...names]
}

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    const timestamp = new Date().toISOString()
    let parsed
    try {
      parsed = JSON.parse(raw || '{}')
    } catch {
      parsed = null
    }

    if (req.url === '/v1/metrics') {
      const metricNames = parsed ? summarizeMetrics(parsed) : []
      console.log(`[${timestamp}] POST /v1/metrics — ${metricNames.length}種類のmetric受信: ${metricNames.join(', ')}`)
    } else if (req.url === '/v1/logs') {
      console.log(`[${timestamp}] POST /v1/logs — ペイロード受信（${raw.length}バイト）`)
    } else {
      console.log(`[${timestamp}] ${req.method} ${req.url} — 未知のエンドポイント`)
    }

    appendFileSync(currentLogFile(), JSON.stringify({ timestamp, url: req.url, body: parsed ?? raw }) + '\n')

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
})

server.listen(PORT, () => {
  console.log(`otel-debug-collector: http://localhost:${PORT} で待ち受け中（Ctrl+Cで停止）`)
  console.log(`受信ログ: ${LOG_DIR}/YYYY-MM-DD.jsonl（日付ローテーション、保持期間${RETENTION_DAYS}日）`)
})
