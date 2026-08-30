-- カテゴリマスタ
create table categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger categories_updated_at
  before update on categories
  for each row execute procedure update_updated_at();

grant all on table public.categories to postgres, anon, authenticated, service_role;

-- distributor_products.category(text) → category_id(uuid FK)
-- cardinality: many 1つのカテゴリに複数の取扱商品がぶら下がる（カテゴリはマスタ側）
alter table distributor_products
  add column category_id uuid references categories(id);

alter table distributor_products
  drop column category;

alter table distributor_products
  alter column category_id set not null;
