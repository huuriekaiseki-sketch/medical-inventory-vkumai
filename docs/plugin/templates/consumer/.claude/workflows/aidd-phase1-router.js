export const meta = {
  name: 'aidd-phase1-router',
  description: '導入先 wrapper: aidd.config.json の risk を riskConfig として aidd-vkumai:aidd-phase1-router に渡す',
  phases: [{ title: 'Route' }],
}

// Workflow は導入先のファイルを読めない（fs API 無し）ため、固有語彙はここにインラインで持つ。
// aidd.config.json の risk と同じ値を書く（ずれると判定が食い違う）。
const RISK_CONFIG = {
  keywords: [],
  pathPrefixes: [],
  domainKeywords: [],
}

const parsedArgs = typeof args === 'string' ? JSON.parse(args) : (args ?? {})
phase('Route')
return await workflow('aidd-vkumai:aidd-phase1-router', { ...parsedArgs, riskConfig: RISK_CONFIG })
