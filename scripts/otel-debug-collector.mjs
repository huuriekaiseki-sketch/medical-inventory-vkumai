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
// 受信したリクエストは標準出力に要約を出し、生JSONは logs/otel-debug-collector.jsonl に追記する。

import http from 'node:http'
import { appendFileSync, mkdirSync } from 'node:fs'

const PORT = process.env.OTEL_DEBUG_COLLECTOR_PORT ?? 4318
const LOG_FILE = process.env.OTEL_DEBUG_COLLECTOR_LOG_FILE ?? 'logs/otel-debug-collector.jsonl'
mkdirSync('logs', { recursive: true })

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

    appendFileSync(LOG_FILE, JSON.stringify({ timestamp, url: req.url, body: parsed ?? raw }) + '\n')

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
})

server.listen(PORT, () => {
  console.log(`otel-debug-collector: http://localhost:${PORT} で待ち受け中（Ctrl+Cで停止）`)
  console.log(`受信ログ: ${LOG_FILE}`)
})
