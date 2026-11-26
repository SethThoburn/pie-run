-- Public scoreboard. Every posted run is kept; the board shows each name's best.
CREATE TABLE IF NOT EXISTS scores (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT    NOT NULL,
  ms      INTEGER NOT NULL,
  created INTEGER NOT NULL,           -- unix ms
  client  TEXT    NOT NULL            -- salted hash of the poster's IP (rate limiting only)
);
CREATE INDEX IF NOT EXISTS idx_scores_name_ms ON scores (name, ms);
CREATE INDEX IF NOT EXISTS idx_scores_client_created ON scores (client, created);
