CREATE TABLE actors (
  address TEXT PRIMARY KEY,
  public_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 1 CHECK (event_count >= 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired'))
);

CREATE INDEX actors_last_seen ON actors(last_seen_at DESC, address);
CREATE INDEX actors_created ON actors(created_at DESC, address);

CREATE TABLE anchors (
  actor_address TEXT NOT NULL REFERENCES actors(address),
  kind TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  evidence_hash TEXT NOT NULL,
  PRIMARY KEY (actor_address, kind, issuer, subject_hash)
);

CREATE INDEX anchors_subject ON anchors(kind, issuer, subject_hash);
