-- 旧テーブル廃止
drop table if exists products cascade;

-- updated_at 自動更新関数
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- 製品マスタ
create table products (
  id uuid primary key default gen_random_uuid(),
  jan text not null unique,
  ref text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger products_updated_at
  before update on products
  for each row execute procedure update_updated_at();

-- 施設マスタ
create table facilities (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger facilities_updated_at
  before update on facilities
  for each row execute procedure update_updated_at();

-- 代理店テーブル
create table distributor_products (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  maker text not null,
  supplier text not null,
  name text not null,
  reimbursement_price numeric,
  quantity integer not null default 1,
  category text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger distributor_products_updated_at
  before update on distributor_products
  for each row execute procedure update_updated_at();

-- 病院別価格
create table hospital_prices (
  id uuid primary key default gen_random_uuid(),
  distributor_product_id uuid not null references distributor_products(id) on delete cascade,
  facility_id uuid not null references facilities(id) on delete cascade,
  purchase_price numeric not null,
  delivery_price numeric not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(distributor_product_id, facility_id)
);
create trigger hospital_prices_updated_at
  before update on hospital_prices
  for each row execute procedure update_updated_at();
