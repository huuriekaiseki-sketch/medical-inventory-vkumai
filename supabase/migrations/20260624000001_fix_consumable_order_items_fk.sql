-- consumable_order_items.consumable_id に ON DELETE CASCADE を追加
ALTER TABLE consumable_order_items
  DROP CONSTRAINT consumable_order_items_consumable_id_fkey,
  ADD CONSTRAINT consumable_order_items_consumable_id_fkey
    FOREIGN KEY (consumable_id) REFERENCES consumables(id) ON DELETE CASCADE;
