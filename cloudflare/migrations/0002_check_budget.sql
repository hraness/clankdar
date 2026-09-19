-- A single durable reservation counter bounds standalone-check issuance.
-- These quotas are separate from legacy actor/campaign data and never reset it.
CREATE TABLE check_issuance_budget (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  issued_total INTEGER NOT NULL DEFAULT 0 CHECK (issued_total >= 0),
  minute_started INTEGER NOT NULL DEFAULT 0 CHECK (minute_started >= 0),
  minute_issued INTEGER NOT NULL DEFAULT 0 CHECK (minute_issued >= 0)
);
INSERT INTO check_issuance_budget (singleton) VALUES (1);
