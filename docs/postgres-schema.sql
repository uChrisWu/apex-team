-- Run once in the selected development environment's PostgreSQL SQL editor.
BEGIN;

CREATE SCHEMA apex_private;
REVOKE ALL ON SCHEMA apex_private FROM PUBLIC, anon, authenticated;

CREATE TABLE apex_private.users (
  openid text PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  active_post_id text,
  created_at timestamptz NOT NULL
);

CREATE TABLE apex_private.team_posts (
  id text PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES apex_private.users(id),
  mode_code text NOT NULL,
  rank_code text NOT NULL,
  server_code text NOT NULL,
  current_players integer NOT NULL CHECK (current_players BETWEEN 1 AND 3),
  max_players integer NOT NULL DEFAULT 3 CHECK (max_players = 3),
  game_id text NOT NULL,
  note text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('RECRUITING', 'FULL', 'CLOSED', 'EXPIRED')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  create_request_id text NOT NULL,
  UNIQUE (owner_id, create_request_id)
);

CREATE TABLE apex_private.app_config (
  id text PRIMARY KEY,
  data jsonb NOT NULL
);

CREATE INDEX team_posts_hall_recent ON apex_private.team_posts (created_at DESC, id DESC)
  WHERE status = 'RECRUITING' AND deleted_at IS NULL;
CREATE INDEX team_posts_hall_filters ON apex_private.team_posts
  (mode_code, server_code, rank_code, current_players, created_at DESC, id DESC)
  WHERE status = 'RECRUITING' AND deleted_at IS NULL;
CREATE INDEX team_posts_mine_recent ON apex_private.team_posts (owner_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

REVOKE ALL ON ALL TABLES IN SCHEMA apex_private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA apex_private TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA apex_private TO service_role;

ALTER TABLE apex_private.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE apex_private.users FORCE ROW LEVEL SECURITY;
ALTER TABLE apex_private.team_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE apex_private.team_posts FORCE ROW LEVEL SECURITY;
ALTER TABLE apex_private.app_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE apex_private.app_config FORCE ROW LEVEL SECURITY;

COMMIT;
