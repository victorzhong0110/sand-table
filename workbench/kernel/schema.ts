export const SCHEMA_VERSION = 2;

export const MIGRATIONS: string[] = [
  `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE objects (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  type_version INTEGER NOT NULL DEFAULT 1,
  title        TEXT NOT NULL DEFAULT '',
  data         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)),
  source       TEXT CHECK (source IS NULL OR json_valid(source)),
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  created_by   TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  updated_by   TEXT NOT NULL,
  rev          INTEGER NOT NULL,
  deleted_rev  INTEGER
);
CREATE INDEX objects_type ON objects(type) WHERE deleted_rev IS NULL;
CREATE INDEX objects_rev  ON objects(rev);

CREATE TABLE presentations (
  id          TEXT PRIMARY KEY,
  board_id    TEXT NOT NULL REFERENCES objects(id),
  object_id   TEXT NOT NULL REFERENCES objects(id),
  parent_id   TEXT REFERENCES presentations(id),
  x           REAL NOT NULL,
  y           REAL NOT NULL,
  width       REAL NOT NULL CHECK (width  > 0),
  height      REAL NOT NULL CHECK (height > 0),
  z           INTEGER NOT NULL DEFAULT 0,
  locked      INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
  appearance  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(appearance)),
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT NOT NULL,
  rev         INTEGER NOT NULL,
  deleted_rev INTEGER,
  CHECK (board_id <> object_id)
);
CREATE INDEX presentations_board  ON presentations(board_id)  WHERE deleted_rev IS NULL;
CREATE INDEX presentations_object ON presentations(object_id) WHERE deleted_rev IS NULL;
CREATE INDEX presentations_rev    ON presentations(rev);

CREATE TABLE relations (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  source_id   TEXT NOT NULL REFERENCES objects(id),
  target_id   TEXT NOT NULL REFERENCES objects(id),
  status      TEXT NOT NULL CHECK (status IN ('confirmed', 'inferred')),
  basis       TEXT,
  attributes  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attributes)),
  evidence    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence)),
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  created_by  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT NOT NULL,
  rev         INTEGER NOT NULL,
  deleted_rev INTEGER,
  CHECK (source_id <> target_id)
);
CREATE INDEX relations_source ON relations(source_id) WHERE deleted_rev IS NULL;
CREATE INDEX relations_target ON relations(target_id) WHERE deleted_rev IS NULL;
CREATE INDEX relations_rev    ON relations(rev);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value)),
  rev   INTEGER NOT NULL
);

CREATE TABLE packs (
  id       TEXT PRIMARY KEY,
  kind     TEXT NOT NULL CHECK (kind IN ('builtin', 'data')),
  version  INTEGER NOT NULL,
  enabled  INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  manifest TEXT CHECK (manifest IS NULL OR json_valid(manifest)),
  rev      INTEGER NOT NULL
);

CREATE TABLE history (
  id         TEXT PRIMARY KEY,
  parent_id  TEXT REFERENCES history(id),
  seq        INTEGER NOT NULL UNIQUE,
  intent_id  TEXT NOT NULL,
  label      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  actor      TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent')),
  at         INTEGER NOT NULL,
  changes    TEXT NOT NULL CHECK (json_valid(changes)),
  bytes      INTEGER NOT NULL
);
CREATE INDEX history_parent ON history(parent_id);

CREATE TABLE audit (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  at           INTEGER NOT NULL,
  actor        TEXT NOT NULL,
  actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent', 'system')),
  action       TEXT NOT NULL,
  history_id   TEXT,
  detail       TEXT CHECK (detail IS NULL OR json_valid(detail))
);

CREATE TABLE activities (
  actor       TEXT PRIMARY KEY,
  state       TEXT NOT NULL CHECK (state IN ('running', 'waiting', 'done', 'unknown')),
  task        TEXT NOT NULL,
  action      TEXT NOT NULL,
  board_id    TEXT,
  object_ids  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(object_ids)),
  reported_at INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE views (
  id         TEXT PRIMARY KEY,
  board_id   TEXT NOT NULL,
  camera     TEXT NOT NULL CHECK (json_valid(camera)),
  selection  TEXT NOT NULL CHECK (json_valid(selection)),
  nav_stack  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(nav_stack)),
  updated_at INTEGER NOT NULL
);

CREATE TABLE agent_reads (
  actor       TEXT PRIMARY KEY,
  history_seq INTEGER NOT NULL,
  at          INTEGER NOT NULL
);

CREATE TABLE blobs (
  sha256     TEXT PRIMARY KEY,
  mime       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`,
  `ALTER TABLE settings ADD COLUMN deleted_rev INTEGER;
ALTER TABLE packs ADD COLUMN deleted_rev INTEGER;`,
];
