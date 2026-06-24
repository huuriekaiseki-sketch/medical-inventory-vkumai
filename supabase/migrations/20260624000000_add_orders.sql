-- supabase/migrations/20260624000000_add_orders.sql

-- 症例発注
CREATE TABLE case_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  case_datetime TIMESTAMPTZ NOT NULL,
  procedure_name TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  patient_initials TEXT NOT NULL,
  gender TEXT NOT NULL CHECK (gender IN ('male', 'female', 'other')),
  doctor_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TRIGGER case_orders_updated_at
  BEFORE UPDATE ON case_orders
  FOR EACH ROW EXECUTE PROCEDURE update_updated_at();

CREATE TABLE case_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_order_id UUID NOT NULL REFERENCES case_orders(id) ON DELETE CASCADE,
  jan TEXT NOT NULL,
  lot TEXT,
  ubd TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 消耗品カタログ
CREATE TABLE consumables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  jan TEXT,
  purpose TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TRIGGER consumables_updated_at
  BEFORE UPDATE ON consumables
  FOR EACH ROW EXECUTE PROCEDURE update_updated_at();

-- 消耗品発注
CREATE TABLE consumable_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TRIGGER consumable_orders_updated_at
  BEFORE UPDATE ON consumable_orders
  FOR EACH ROW EXECUTE PROCEDURE update_updated_at();

CREATE TABLE consumable_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  consumable_order_id UUID NOT NULL REFERENCES consumable_orders(id) ON DELETE CASCADE,
  consumable_id UUID NOT NULL REFERENCES consumables(id),
  quantity INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 短貸発注
CREATE TABLE loan_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  procedure_name TEXT NOT NULL,
  maker TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TRIGGER loan_orders_updated_at
  BEFORE UPDATE ON loan_orders
  FOR EACH ROW EXECUTE PROCEDURE update_updated_at();

CREATE TABLE loan_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_order_id UUID NOT NULL REFERENCES loan_orders(id) ON DELETE CASCADE,
  jan TEXT,
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 短貸返却
CREATE TABLE loan_returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  return_datetime TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'returned')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TRIGGER loan_returns_updated_at
  BEFORE UPDATE ON loan_returns
  FOR EACH ROW EXECUTE PROCEDURE update_updated_at();

CREATE TABLE loan_return_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_return_id UUID NOT NULL REFERENCES loan_returns(id) ON DELETE CASCADE,
  jan TEXT NOT NULL,
  lot TEXT,
  ubd TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- パーミッション
GRANT ALL ON TABLE public.case_orders           TO postgres, anon, authenticated, service_role;
GRANT ALL ON TABLE public.case_order_items      TO postgres, anon, authenticated, service_role;
GRANT ALL ON TABLE public.consumables           TO postgres, anon, authenticated, service_role;
GRANT ALL ON TABLE public.consumable_orders     TO postgres, anon, authenticated, service_role;
GRANT ALL ON TABLE public.consumable_order_items TO postgres, anon, authenticated, service_role;
GRANT ALL ON TABLE public.loan_orders           TO postgres, anon, authenticated, service_role;
GRANT ALL ON TABLE public.loan_order_items      TO postgres, anon, authenticated, service_role;
GRANT ALL ON TABLE public.loan_returns          TO postgres, anon, authenticated, service_role;
GRANT ALL ON TABLE public.loan_return_items     TO postgres, anon, authenticated, service_role;
