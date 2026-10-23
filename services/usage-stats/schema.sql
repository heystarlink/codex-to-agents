CREATE TABLE IF NOT EXISTS installations (
  installation_id TEXT PRIMARY KEY NOT NULL,
  first_day TEXT NOT NULL,
  last_day TEXT NOT NULL,
  latest_version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_activity (
  installation_id TEXT NOT NULL REFERENCES installations(installation_id),
  activity_day TEXT NOT NULL,
  version TEXT NOT NULL,
  PRIMARY KEY (installation_id, activity_day)
);

CREATE INDEX IF NOT EXISTS daily_activity_day ON daily_activity(activity_day);
