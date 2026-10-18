ALTER TABLE orders ADD COLUMN next_close_check_at timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE INDEX orders_closing_due ON orders(next_close_check_at) WHERE state='CLOSING';
