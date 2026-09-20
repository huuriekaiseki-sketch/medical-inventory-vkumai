// aidd.config.json が scripts/lib/aidd-config.schema.json に適合するかを見る。
//
// WHY(2026-09-12): スキーマは配っていたが、**中身を検証する検査が 1 本も無かった**。
//      参照していたのは「配布物に含まれるか」を見る 2 か所だけで、設定がスキーマから
//      静かにずれても誰も気づけない。実際この日、ひな形へ errorResponse を足したときに
//      `_comment` を書いて**スキーマ違反を作った**（errorResponse だけ _comment を
//      許していなかった）。検査が無いので緑のまま通った——自分で穴を通って実証した形。
//
// なぜ自作か: JSON Schema の検証器は依存に無く、依存追加は人の承認が要る。
//      このスキーマが使う語彙は限られている（下の SUPPORTED）ので、その範囲だけを実装する。
//      **未知の語彙が増えたら落とす**ので、実装が追いつかないまま黙って素通りすることはない。
//
// 限界（先に書く）:
//   - $ref は "#/$defs/<名前>" の形だけを解決する（このスキーマが使う唯一の形）
//   - oneOf / anyOf / allOf / pattern / format は未実装。使われたら「知らない語彙」で落とす
//   - 値の意味（パスが実在するか等）は見ない。形だけ
//
// 使い方: node scripts/lib/validate-aidd-config.mjs <config.json> [<schema.json>]
// 終了コード: 0 = 適合 / 1 = 違反あり / 2 = 読めない・知らない語彙
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { writeLine } from './stdout-sync.mjs'
import { realpathSync } from 'node:fs'

const SUPPORTED = new Set([
  '$schema',
  '$id',
  'title',
  'description',
  'type',
  'properties',
  'additionalProperties',
  'required',
  'items',
  'minLength',
  'minimum',
  'minProperties',
  'uniqueItems',
  '$ref',
  '$defs',
  'enum',
])

/** スキーマの語彙が実装の範囲に収まっているか。収まっていなければ黙らずに落とす */
function assertSupported(schema, where, unknown) {
  if (schema === null || typeof schema !== 'object') return
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key)) unknown.push(`${where}: 知らない語彙 "${key}"`)
  }
  if (schema.properties) {
    for (const [name, sub] of Object.entries(schema.properties)) {
      assertSupported(sub, `${where}.${name}`, unknown)
    }
  }
  if (schema.items) assertSupported(schema.items, `${where}[]`, unknown)
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    assertSupported(schema.additionalProperties, `${where}.*`, unknown)
  }
  if (schema.$defs) {
    for (const [name, sub] of Object.entries(schema.$defs)) {
      assertSupported(sub, `$defs.${name}`, unknown)
    }
  }
}

function resolve(schema, root) {
  if (schema && schema.$ref) {
    const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref)
    if (!m) throw new Error(`解決できない $ref: ${schema.$ref}`)
    const target = root.$defs?.[m[1]]
    if (!target) throw new Error(`$defs に無い: ${m[1]}`)
    return target
  }
  return schema
}

function typeOf(value) {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

function validate(value, schemaRaw, root, where, out) {
  const schema = resolve(schemaRaw, root)
  if (!schema) return

  if (schema.type) {
    const actual = typeOf(value)
    const want = schema.type === 'integer' ? 'number' : schema.type
    if (actual !== want || (schema.type === 'integer' && !Number.isInteger(value))) {
      out.push(`${where}: 型が ${schema.type} でない（${actual}）`)
      return
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    out.push(`${where}: 値が enum に無い（${JSON.stringify(value)}）`)
  }
  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) {
    out.push(`${where}: 文字数が ${schema.minLength} 未満`)
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    out.push(`${where}: ${schema.minimum} 未満`)
  }

  if (typeOf(value) === 'array') {
    if (schema.items) value.forEach((v, i) => validate(v, schema.items, root, `${where}[${i}]`, out))
    if (schema.uniqueItems) {
      const seen = new Set(value.map((v) => JSON.stringify(v)))
      if (seen.size !== value.length) out.push(`${where}: 同じ値が 2 つ以上ある`)
    }
  }

  if (typeOf(value) === 'object') {
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) {
      out.push(`${where}: 項目が ${schema.minProperties} 個未満`)
    }
    for (const name of schema.required ?? []) {
      if (!(name in value)) out.push(`${where}: 必須の "${name}" が無い`)
    }
    for (const [name, v] of Object.entries(value)) {
      const sub = schema.properties?.[name]
      if (sub) {
        validate(v, sub, root, `${where}.${name}`, out)
      } else if (schema.additionalProperties === false) {
        out.push(`${where}: スキーマに無い項目 "${name}"`)
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validate(v, schema.additionalProperties, root, `${where}.${name}`, out)
      }
    }
  }
}

// WHY(2026-09-12): ひな形の limits は **わざと未確定**（0 と TODO）にしてある。
//      人に聞くまで先へ進ませないための仕掛けで、その役は check-design-answers.test.sh が持つ。
//      ここでスキーマの minimum: 1 に当てると「ひな形が正しい状態」を違反として読むので、
//      ひな形を見るときだけ limits を外せるようにする（中心の設定では外さない）。
export function validateConfig(configPath, schemaPath, { skipKeys = [] } = {}) {
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'))
  const unknown = []
  assertSupported(schema, '(root)', unknown)
  if (unknown.length > 0) return { unknown, violations: [] }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const violations = []
  validate(config, schema, schema, '(root)', violations)
  const kept = violations.filter((v) => !skipKeys.some((k) => v.startsWith(`(root).${k}`)))
  return { unknown: [], violations: kept }
}

// WHY(issue #806): 素の比較（import.meta.url と、argv[1] の前に file:// を付けた文字列）だと、symlink を含むパスで
//      起動したとき（例: macOS の一時ディレクトリ）に一致せず、main() が走らないまま無出力・exit 0 で終わる。
//      import.meta.url は実体パス、argv[1] は symlink のままだからである。検査にとって無出力・exit 0 は
//      「問題なし」と見分けがつかないので、実体パスへ直してから比べる。
//      この書き方へ戻すと、直接起動の判定を走査する検査（issue #806）が落とす
function isRunAsCli() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href
  } catch {
    return false
  }
}
if (isRunAsCli()) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  // ひな形を見るとき用。未確定のまま置く節を外す（既定では何も外さない）。
  // WHY(2026-09-12): 最初は「-- で始まらないもの」だけを位置引数にしたが、
  //      それでは `--skip limits` の**値**まで位置引数に混ざり、`limits` をスキーマの
  //      パスとして開こうとして ENOENT で落ちた。フラグとその値を一緒に外す。
  const raw = process.argv.slice(2)
  const args = []
  let skipKeys = []
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === '--skip') {
      skipKeys = (raw[i + 1] ?? '').split(',').filter(Boolean)
      i += 1
    } else if (!raw[i].startsWith('--')) {
      args.push(raw[i])
    }
  }
  const configPath = args[0]
  const schemaPath = args[1] ?? path.join(here, 'aidd-config.schema.json')
  if (!configPath) {
    writeLine('使い方: node validate-aidd-config.mjs <config.json> [<schema.json>] [--skip limits]')
    process.exitCode = 2
  } else if (!fs.existsSync(configPath)) {
    writeLine(`対象なし: ${configPath} が無い`)
    process.exitCode = 0
  } else {
    const { unknown, violations } = validateConfig(configPath, schemaPath, { skipKeys })
    if (unknown.length > 0) {
      for (const u of unknown) writeLine(`NG ${u}`)
      writeLine('この検証器が知らない語彙がスキーマに入りました。実装を足すまで通しません')
      process.exitCode = 2
    } else {
      for (const v of violations) writeLine(`NG ${v}`)
      writeLine(`violations=${violations.length}`)
      process.exitCode = violations.length > 0 ? 1 : 0
    }
  }
}
