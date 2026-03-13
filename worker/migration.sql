-- Migration: lisää category + sort_order palveluihin, owner_name + business_id yrityksiin

ALTER TABLE services ADD COLUMN category TEXT;
ALTER TABLE services ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

ALTER TABLE businesses ADD COLUMN owner_name TEXT;
ALTER TABLE businesses ADD COLUMN business_id TEXT;
