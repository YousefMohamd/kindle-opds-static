CREATE TABLE IF NOT EXISTS drive_libraries (
  folder_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
  added_by TEXT NOT NULL DEFAULT '', added_at TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  submitter_tg_id INTEGER,
  visibility TEXT NOT NULL DEFAULT 'private',
  requested_at TEXT,
  reviewed_at TEXT);
INSERT INTO drive_libraries(folder_id, title, added_by, added_at, status, submitter_tg_id, visibility) VALUES ('1B6DI3hXN_v1M2HunmRyX_6SnBvmcvqDQ', 'كتب | يوسف محمد', '7283934644', '2026-11-27', 'active', 7283934644, 'private') ON CONFLICT(folder_id) DO UPDATE SET title=excluded.title, added_by=excluded.added_by, added_at=excluded.added_at, status=excluded.status, submitter_tg_id=COALESCE(drive_libraries.submitter_tg_id, excluded.submitter_tg_id), visibility=COALESCE(drive_libraries.visibility, excluded.visibility);
