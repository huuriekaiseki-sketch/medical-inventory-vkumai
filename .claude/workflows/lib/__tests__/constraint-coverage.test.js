import { describe, it, expect } from 'vitest'
import {
  assessRisk,
  findRlsTablesWithoutIdorTest,
  findUncoveredConstraintMigrations,
  findUndeclaredCardinality,
} from '../constraint-coverage.js'

const run = (migrations, integrationSource = '') =>
  findUncoveredConstraintMigrations({ migrations, integrationSource })

describe('findUncoveredConstraintMigrations', () => {
  it('制約を導入していないmigrationは判定対象に数えない', () => {
    const result = run([
      { name: '001_add_column.sql', sql: 'ALTER TABLE orders ADD COLUMN memo text;' },
    ])
    expect(result.total).toBe(0)
    expect(result.uncovered).toEqual([])
  })

  it('制約を導入し、そのテーブルが統合テストに登場すればuncoveredにしない', () => {
    const result = run(
      [
        {
          name: '002_unique.sql',
          sql: 'CREATE UNIQUE INDEX foo ON loan_returns (loan_order_id);',
        },
      ],
      "await db.from('loan_returns').select('*')",
    )
    expect(result.total).toBe(1)
    expect(result.uncovered).toEqual([])
  })

  it('制約を導入したのにテーブルがどの統合テストにも登場しなければuncoveredにする', () => {
    // WHY: #675 と同じ形。静的SQL検証しか無い制約は「破ろうとしたら拒否される」を
    //      一度も確かめていないため、実DB統合テストの欠落を検知する必要がある
    const result = run(
      [
        {
          name: '003_compat.sql',
          sql: `CREATE TABLE product_compatibilities (
                  product_id_1 uuid NOT NULL REFERENCES products(id),
                  CONSTRAINT ordered_pair CHECK (product_id_1 < product_id_2),
                  UNIQUE (category_id, product_id_1, product_id_2)
                );`,
        },
      ],
      "await db.from('loan_returns').select('*')",
    )
    expect(result.uncovered).toEqual([
      {
        name: '003_compat.sql',
        kinds: ['UNIQUE', 'FK', 'CHECK'],
        tables: ['product_compatibilities'],
        constraintCount: 3,
      },
    ])
  })

  it('コメント中のCHECK・UNIQUE等は制約として拾わない', () => {
    const result = run([
      {
        name: '004_comment_only.sql',
        sql: `-- product_id_1 < product_id_2 の CHECK 制約により (a,b) と (b,a) を同一視する
              /* UNIQUE にはしない */
              ALTER TABLE orders ADD COLUMN memo text;`,
      },
    ])
    expect(result.total).toBe(0)
  })

  it('opt-outマーカーがあればuncoveredにせず、理由をoptedOutへ記録する', () => {
    const result = run([
      {
        name: '005_internal.sql',
        sql: `-- integration-coverage: not-required スキーマ監視用の内部テーブルで業務データを持たない
              CREATE TABLE schema_drift_log (
                id uuid PRIMARY KEY,
                kind text NOT NULL CHECK (kind IN ('added','removed'))
              );`,
      },
    ])
    expect(result.uncovered).toEqual([])
    expect(result.optedOut).toEqual([
      {
        name: '005_internal.sql',
        reason: 'スキーマ監視用の内部テーブルで業務データを持たない',
      },
    ])
  })

  it('テーブル名を抽出できないmigration（ポリシーのみ等）は判定対象外にする', () => {
    // WHY: 「どのテーブルを守るのか」が特定できない以上、カバレッジの有無を主張できない。
    //      偽陽性で警告を出すより黙る側に倒す（warning-onlyの信頼を保つため）
    const result = run([
      {
        name: '006_policy.sql',
        sql: "CREATE POLICY p ON x FOR SELECT USING (is_admin()) WITH CHECK (is_admin());",
      },
    ])
    expect(result.total).toBe(1)
    expect(result.uncovered).toEqual([])
  })
})

describe('assessRisk（怪しさの機械判定）', () => {
  // WHY: フラットな一覧では「6件あります」で終わって結局放置される。
  //      どれから見るべきかを機械で決めるところまでが検知の仕事（issue #675の教訓）
  const assess = (o) =>
    assessRisk({ tables: [], constraintCount: 0, appSource: '', allMigrationSql: '', ...o })

  it('アプリのコードが一度も触っていないテーブルはlow（裏方テーブル）', () => {
    const result = assess({
      tables: ['schema_drift_log'],
      constraintCount: 5,
      appSource: "await db.from('loan_returns').select()",
    })
    expect(result.level).toBe('low')
    expect(result.reasons[0]).toContain('裏方テーブル')
  })

  it('アプリが触っていて制約が3個以上あればhigh', () => {
    const result = assess({
      tables: ['product_compatibilities'],
      constraintCount: 7,
      appSource: "await db.from('product_compatibilities').select()",
    })
    expect(result.level).toBe('high')
  })

  it('アプリが触っていて facility_id を持てば、制約が少なくてもhigh（施設境界）', () => {
    const result = assess({
      tables: ['loan_returns'],
      constraintCount: 1,
      appSource: "await db.from('loan_returns').select()",
      allMigrationSql: 'CREATE TABLE loan_returns (id uuid, facility_id uuid NOT NULL);',
    })
    expect(result.level).toBe('high')
    expect(result.reasons.join()).toContain('施設境界')
  })

  it('facility_id列を持たなくても、RLSポリシーが is_facility_member を使えば施設境界扱いにする', () => {
    // WHY: 明細テーブル（loan_return_items 等）は facility_id 列を持たず、親経由の
    //      EXISTS で施設スコープになる。列だけを見ると施設境界を取りこぼし、
    //      本来 high のものを medium に過小評価する（実際に踏んだ）
    const result = assess({
      tables: ['loan_return_items'],
      constraintCount: 1,
      appSource: "await db.from('loan_return_items').select()",
      allMigrationSql: `
        CREATE TABLE loan_return_items (id uuid, loan_return_id uuid);
        CREATE POLICY "facility_member_or_admin" ON loan_return_items
          FOR ALL TO authenticated
          USING (EXISTS (SELECT 1 FROM loan_returns o
            WHERE o.id = loan_return_items.loan_return_id
              AND (is_facility_member(o.facility_id) OR is_admin())));`,
    })
    expect(result.level).toBe('high')
    expect(result.reasons.join()).toContain('親経由で施設境界')
  })

  it('別テーブルのFK参照先として名前が出るだけでは施設境界扱いにしない', () => {
    // WHY: `create table[^;]*\bt\b[^;]*facility_id` と緩く書くと、
    //      hospital_prices の `references distributor_products(id)` に一致して
    //      facility_id を持たない distributor_products まで施設境界扱いになる（実際に踏んだ）
    const result = assess({
      tables: ['distributor_products'],
      constraintCount: 1,
      appSource: "await db.from('distributor_products').select()",
      allMigrationSql: `
        CREATE TABLE distributor_products (id uuid, maker text);
        CREATE TABLE hospital_prices (
          distributor_product_id uuid REFERENCES distributor_products(id),
          facility_id uuid NOT NULL
        );`,
    })
    expect(result.level).toBe('medium')
    expect(result.reasons.join()).not.toContain('施設境界')
  })

  it('アプリが触っているが制約も少なく施設境界にも関わらなければmedium', () => {
    const result = assess({
      tables: ['consumable_order_items'],
      constraintCount: 1,
      appSource: "await db.from('consumable_order_items').select()",
    })
    expect(result.level).toBe('medium')
  })
})

describe('findRlsTablesWithoutIdorTest（認可側への応用）', () => {
  const sql = `
    CREATE POLICY loan_returns_select ON loan_returns FOR SELECT USING (is_facility_member(facility_id));
    CREATE POLICY hospital_prices_select ON public.hospital_prices FOR SELECT USING (is_facility_member(facility_id));
  `

  it('IDOR統合テストに登場しないテーブルだけをuncoveredにする', () => {
    const result = findRlsTablesWithoutIdorTest({
      allMigrationSql: sql,
      idorTestSource: "it('ユーザーBは施設Aのloan_returnsを1件も取得できない', ...)",
    })
    expect(result.policyTables).toEqual(['hospital_prices', 'loan_returns'])
    expect(result.uncovered).toEqual(['hospital_prices'])
  })

  it('IDORテストが空なら、ポリシーを持つ全テーブルがuncoveredになる', () => {
    const result = findRlsTablesWithoutIdorTest({ allMigrationSql: sql, idorTestSource: '' })
    expect(result.uncovered).toEqual(['hospital_prices', 'loan_returns'])
  })

  it('notRequired に挙げたテーブルはuncoveredから外れる（検知条件の訂正）', () => {
    // WHY: categories 等のマスタは意図的にテナント非分離で、施設境界の約束がそもそも無い。
    //      IDORの概念が無いテーブルを負債として数え続けると、リストの信用が落ちる
    const result = findRlsTablesWithoutIdorTest({
      allMigrationSql: sql,
      idorTestSource: '',
      notRequired: ['hospital_prices'],
    })
    expect(result.policyTables).toEqual(['hospital_prices', 'loan_returns'])
    expect(result.uncovered).toEqual(['loan_returns'])
  })

  it('ポリシーが1つも無ければ空を返す', () => {
    const result = findRlsTablesWithoutIdorTest({
      allMigrationSql: 'CREATE TABLE foo (id uuid);',
      idorTestSource: '',
    })
    expect(result).toEqual({ policyTables: [], uncovered: [] })
  })
})

describe('findUndeclaredCardinality', () => {
  const alterAddFk = {
    name: '20260714000005_orders_history_prereqs.sql',
    sql: `ALTER TABLE loan_returns
            ADD COLUMN loan_order_id UUID REFERENCES loan_orders(id) ON DELETE SET NULL;`,
  }

  it('後付けFK列にUNIQUEが無ければundeclaredにする（#675の発生時点を再現）', () => {
    // WHY: これが #675 の本体。2026-07-14 にこの列が追加された時点で
    //      「loan_order 1件に返却は何件までか」が宣言されず、そのまま6週間残った
    const result = findUndeclaredCardinality({ migrations: [alterAddFk] })
    expect(result.added).toBe(1)
    expect(result.undeclared).toEqual([
      {
        name: '20260714000005_orders_history_prereqs.sql',
        table: 'loan_returns',
        column: 'loan_order_id',
      },
    ])
  })

  it('後から別migrationでUNIQUEが追加されればundeclaredにしない（#675の修正後）', () => {
    const result = findUndeclaredCardinality({
      migrations: [
        alterAddFk,
        {
          name: '20260828000001_add_unique.sql',
          sql: `CREATE UNIQUE INDEX loan_returns_loan_order_id_unique
                  ON loan_returns (loan_order_id) WHERE loan_order_id IS NOT NULL;`,
        },
      ],
    })
    expect(result.undeclared).toEqual([])
  })

  it('無関係なテーブルの複合UNIQUEを宣言済みと誤判定しない', () => {
    // WHY: 列名だけで照合すると product_compatibilities の UNIQUE (category_id, ...) が
    //      distributor_products.category_id の宣言として誤って一致する（実装中に実際に踏んだ）
    const result = findUndeclaredCardinality({
      migrations: [
        {
          name: '001_add_categories.sql',
          sql: 'ALTER TABLE distributor_products ADD COLUMN category_id uuid REFERENCES categories(id);',
        },
        {
          name: '002_compat.sql',
          sql: `CREATE TABLE product_compatibilities (
                  UNIQUE (category_id, product_id_1, product_id_2)
                );`,
        },
      ],
    })
    expect(result.undeclared).toEqual([
      { name: '001_add_categories.sql', table: 'distributor_products', column: 'category_id' },
    ])
  })

  it('`-- cardinality: many <理由>` があれば1対多の明示としてdeclaredManyに記録する', () => {
    const result = findUndeclaredCardinality({
      migrations: [
        {
          name: '001_add_categories.sql',
          sql: `-- cardinality: many 1カテゴリに複数の取扱商品がぶら下がる
                ALTER TABLE distributor_products ADD COLUMN category_id uuid REFERENCES categories(id);`,
        },
      ],
    })
    expect(result.undeclared).toEqual([])
    expect(result.declaredMany).toEqual([
      {
        name: '001_add_categories.sql',
        column: 'category_id',
        reason: '1カテゴリに複数の取扱商品がぶら下がる',
      },
    ])
  })

  it('`<table>.<column>` を明示すれば別のmigrationからでも1対多を宣言できる', () => {
    // WHY: 適用済みのmigrationを後から編集したくないケースの逃げ道。
    //      列を明示させることで、無関係な宣言が誤って効くことを防ぐ
    const result = findUndeclaredCardinality({
      migrations: [
        {
          name: '001_add_categories.sql',
          sql: 'ALTER TABLE distributor_products ADD COLUMN category_id uuid REFERENCES categories(id);',
        },
        {
          name: '999_declarations.sql',
          sql: '-- cardinality: many distributor_products.category_id 1カテゴリに複数の取扱商品',
        },
      ],
    })
    expect(result.undeclared).toEqual([])
    expect(result.declaredMany[0].reason).toBe('1カテゴリに複数の取扱商品')
  })

  it('別の列に対する宣言は流用されない', () => {
    const result = findUndeclaredCardinality({
      migrations: [
        {
          name: '001_add_categories.sql',
          sql: 'ALTER TABLE distributor_products ADD COLUMN category_id uuid REFERENCES categories(id);',
        },
        {
          name: '999_declarations.sql',
          sql: '-- cardinality: many loan_returns.loan_order_id 別の列の宣言',
        },
      ],
    })
    expect(result.undeclared).toEqual([
      { name: '001_add_categories.sql', table: 'distributor_products', column: 'category_id' },
    ])
  })

  it('CREATE TABLE内のFKは対象外（最初から多対1として設計されたものが大半でノイズになる）', () => {
    const result = findUndeclaredCardinality({
      migrations: [
        {
          name: '001_create.sql',
          sql: 'CREATE TABLE loan_order_items (loan_order_id uuid REFERENCES loan_orders(id));',
        },
      ],
    })
    expect(result.added).toBe(0)
    expect(result.undeclared).toEqual([])
  })
})
