CREATE TABLE IF NOT EXISTS media_segments (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (game_id) REFERENCES games(id)
);

CREATE INDEX IF NOT EXISTS media_segments_game_time ON media_segments(game_id, start_ms, end_ms);
