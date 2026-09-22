CREATE TABLE IF NOT EXISTS moment_saves (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  event_id TEXT,
  game_time_seconds INTEGER NOT NULL,
  viewer_session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (game_id, event_id, viewer_session_id)
);

CREATE INDEX IF NOT EXISTS moment_saves_game_created
  ON moment_saves(game_id, created_at);
