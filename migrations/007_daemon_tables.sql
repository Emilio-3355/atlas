-- Remote control: daemon connections + commands

CREATE TABLE IF NOT EXISTS daemon_connections (
  id              SERIAL PRIMARY KEY,
  daemon_id       TEXT NOT NULL,
  hostname        TEXT NOT NULL,
  ip_address      TEXT,
  connected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disconnected_at TIMESTAMPTZ,
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata        JSONB DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS daemon_commands (
  id              SERIAL PRIMARY KEY,
  command_id      TEXT UNIQUE NOT NULL,
  daemon_id       TEXT,
  action          TEXT NOT NULL,
  command_text    TEXT,
  directory       TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  output          TEXT,
  exit_code       INTEGER,
  duration_ms     INTEGER,
  conversation_id TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_daemon_connections_daemon_id ON daemon_connections(daemon_id);
CREATE INDEX idx_daemon_commands_command_id ON daemon_commands(command_id);
CREATE INDEX idx_daemon_commands_status ON daemon_commands(status);
