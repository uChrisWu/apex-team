-- Run after postgres-schema.sql. The RPC endpoint is reachable from the gateway,
-- so this invoker function checks the database role before touching private data.
CREATE OR REPLACE FUNCTION public.apex_backend_call(
  p_action text, p_openid text, p_payload jsonb, p_now timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = apex_private, pg_temp
AS $$
DECLARE
  v_user apex_private.users%ROWTYPE;
  v_post apex_private.team_posts%ROWTYPE;
  v_active apex_private.team_posts%ROWTYPE;
  v_config jsonb;
  v_id text;
  v_request_id text;
  v_mode text;
  v_rank text;
  v_server text;
  v_game_id text;
  v_note text;
  v_players integer;
  v_version integer;
  v_limit integer;
  v_count integer;
  v_items jsonb;
  v_last jsonb;
  v_card jsonb;
  v_status text;
  v_owner boolean;
BEGIN
  IF current_user <> 'service_role' THEN
    RAISE EXCEPTION 'apex backend access denied' USING ERRCODE = '42501';
  END IF;

  IF p_action = 'getConfig' THEN
    SELECT data INTO STRICT v_config FROM apex_private.app_config WHERE id = 'main';
    RETURN jsonb_build_object('code', 'OK', 'data', v_config);
  END IF;

  IF p_action = 'ensureUser' THEN
    IF p_openid IS NULL OR p_openid = '' THEN
      RETURN jsonb_build_object('code', 'UNAUTHENTICATED', 'message', '无法取得微信身份');
    END IF;
    INSERT INTO apex_private.users (openid, id, created_at)
      VALUES (p_openid, gen_random_uuid(), p_now)
      ON CONFLICT (openid) DO NOTHING;
    SELECT * INTO STRICT v_user FROM apex_private.users WHERE openid = p_openid;
    IF v_user.active_post_id IS NOT NULL THEN
      SELECT * INTO v_active FROM apex_private.team_posts WHERE id = v_user.active_post_id;
    END IF;
    v_id := CASE WHEN v_active.id IS NOT NULL AND v_active.deleted_at IS NULL
      AND v_active.status = 'RECRUITING' AND v_active.expires_at > p_now
      THEN v_active.id ELSE NULL END;
    RETURN jsonb_build_object('code', 'OK', 'data', jsonb_build_object(
      'userId', v_user.id, 'hasActivePost', v_id IS NOT NULL, 'activePostId', v_id));
  END IF;

  IF p_action IN ('getContact', 'createPost', 'updatePost', 'closePost', 'deletePost', 'listMyPosts') THEN
    IF p_openid IS NULL OR p_openid = '' THEN
      RETURN jsonb_build_object('code', 'UNAUTHENTICATED', 'message', '请先登录');
    END IF;
    IF p_action IN ('createPost', 'updatePost', 'closePost', 'deletePost') THEN
      SELECT * INTO v_user FROM apex_private.users WHERE openid = p_openid FOR UPDATE;
    ELSE
      SELECT * INTO v_user FROM apex_private.users WHERE openid = p_openid;
    END IF;
    IF v_user.id IS NULL THEN
      RETURN jsonb_build_object('code', 'UNAUTHENTICATED', 'message', '请先登录');
    END IF;
  ELSIF p_openid IS NOT NULL AND p_openid <> '' THEN
    SELECT * INTO v_user FROM apex_private.users WHERE openid = p_openid;
  END IF;

  IF p_action = 'createPost' THEN
    v_request_id := p_payload->>'requestId';
    v_id := 'p_' || encode(sha256(convert_to(v_user.id::text || ':' || v_request_id, 'UTF8')), 'hex');
    SELECT * INTO v_post FROM apex_private.team_posts WHERE id = v_id;
    IF v_post.id IS NOT NULL THEN
      RETURN jsonb_build_object('code', 'OK', 'data', jsonb_build_object(
        'id', v_id, 'status', 'RECRUITING', 'version', 1));
    END IF;
    IF v_user.active_post_id IS NOT NULL THEN
      SELECT * INTO v_active FROM apex_private.team_posts WHERE id = v_user.active_post_id;
      IF v_active.id IS NOT NULL AND v_active.deleted_at IS NULL
        AND v_active.status = 'RECRUITING' AND v_active.expires_at > p_now THEN
        RETURN jsonb_build_object('code', 'ACTIVE_POST_EXISTS', 'message', '已有招募中的信息',
          'data', jsonb_build_object('existingPostId', v_active.id));
      END IF;
    END IF;
  END IF;

  IF p_action IN ('createPost', 'updatePost') THEN
    SELECT data INTO STRICT v_config FROM apex_private.app_config WHERE id = 'main';
    v_mode := p_payload->>'modeCode';
    v_rank := p_payload->>'rankCode';
    v_server := p_payload->>'serverCode';
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_config->'modes') AS x(value) WHERE x.value->>'code' = v_mode)
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_config->'ranks') AS x(value) WHERE x.value->>'code' = v_rank)
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_config->'servers') AS x(value) WHERE x.value->>'code' = v_server)
      OR jsonb_typeof(p_payload->'currentPlayers') IS DISTINCT FROM 'number'
      OR COALESCE((p_payload->>'currentPlayers') !~ CASE WHEN p_action = 'createPost' THEN '^[12]$' ELSE '^[123]$' END, true)
      OR jsonb_typeof(p_payload->'gameId') IS DISTINCT FROM 'string'
      OR (p_payload ? 'note' AND jsonb_typeof(p_payload->'note') IS DISTINCT FROM 'string') THEN
      RETURN jsonb_build_object('code', 'VALIDATION_ERROR', 'message', '发布内容无效');
    END IF;
    v_players := (p_payload->>'currentPlayers')::integer;
    v_game_id := btrim(p_payload->>'gameId');
    v_note := btrim(COALESCE(p_payload->>'note', ''));
    IF char_length(v_game_id) < 1 OR char_length(v_game_id) > (v_config->'limits'->>'gameIdMaxLength')::integer
      OR char_length(v_note) > (v_config->'limits'->>'noteMaxLength')::integer THEN
      RETURN jsonb_build_object('code', 'VALIDATION_ERROR', 'message', '游戏 ID 或备注长度无效');
    END IF;
  END IF;

  IF p_action = 'createPost' THEN
    INSERT INTO apex_private.team_posts (id, owner_id, mode_code, rank_code, server_code,
      current_players, game_id, note, status, created_at, updated_at, expires_at, create_request_id)
    VALUES (v_id, v_user.id, v_mode, v_rank, v_server, v_players, v_game_id, v_note,
      'RECRUITING', p_now, p_now,
      p_now + make_interval(mins => (v_config->'limits'->>'expireMinutes')::integer), v_request_id);
    UPDATE apex_private.users SET active_post_id = v_id WHERE openid = p_openid;
    RETURN jsonb_build_object('code', 'OK', 'data', jsonb_build_object(
      'id', v_id, 'status', 'RECRUITING', 'version', 1));
  END IF;

  IF p_action IN ('updatePost', 'closePost', 'deletePost') THEN
    SELECT * INTO v_post FROM apex_private.team_posts WHERE id = p_payload->>'postId' FOR UPDATE;
    IF v_post.id IS NULL OR v_post.deleted_at IS NOT NULL THEN
      RETURN jsonb_build_object('code', 'NOT_FOUND', 'message', '信息不存在或已删除');
    END IF;
    IF v_post.owner_id <> v_user.id THEN
      RETURN jsonb_build_object('code', 'FORBIDDEN', 'message', '只有发布者可以操作');
    END IF;
    v_version := (p_payload->>'version')::integer;
    IF v_post.version <> v_version THEN
      RETURN jsonb_build_object('code', 'VERSION_CONFLICT', 'message', '信息已被更新');
    END IF;
    IF p_action <> 'deletePost' AND (v_post.status <> 'RECRUITING' OR v_post.expires_at <= p_now) THEN
      RETURN jsonb_build_object('code', 'POST_UNAVAILABLE', 'message', '该信息已不在招募中');
    END IF;
    IF p_action = 'updatePost' THEN
      v_status := CASE WHEN v_players = 3 THEN 'FULL' ELSE 'RECRUITING' END;
      UPDATE apex_private.team_posts SET mode_code = v_mode, rank_code = v_rank,
        server_code = v_server, current_players = v_players, game_id = v_game_id,
        note = v_note, status = v_status, updated_at = p_now, version = version + 1
        WHERE id = v_post.id RETURNING * INTO v_post;
    ELSIF p_action = 'closePost' THEN
      UPDATE apex_private.team_posts SET status = 'CLOSED', updated_at = p_now,
        version = version + 1 WHERE id = v_post.id RETURNING * INTO v_post;
    ELSE
      UPDATE apex_private.team_posts SET deleted_at = p_now, updated_at = p_now,
        version = version + 1 WHERE id = v_post.id RETURNING * INTO v_post;
    END IF;
    IF (v_post.status <> 'RECRUITING' OR v_post.deleted_at IS NOT NULL)
      AND v_user.active_post_id = v_post.id THEN
      UPDATE apex_private.users SET active_post_id = NULL
        WHERE openid = p_openid AND active_post_id = v_post.id;
    END IF;
    IF p_action = 'closePost' THEN
      RETURN jsonb_build_object('code', 'OK', 'data', jsonb_build_object(
        'id', v_post.id, 'status', 'CLOSED', 'version', v_post.version));
    ELSIF p_action = 'deletePost' THEN
      RETURN jsonb_build_object('code', 'OK', 'data', jsonb_build_object('id', v_post.id));
    END IF;
  END IF;

  IF p_action IN ('getPost', 'getContact', 'updatePost') THEN
    IF p_action <> 'updatePost' THEN
      SELECT * INTO v_post FROM apex_private.team_posts WHERE id = p_payload->>'postId';
    END IF;
    IF v_post.id IS NULL OR v_post.deleted_at IS NOT NULL THEN
      RETURN jsonb_build_object('code', 'NOT_FOUND', 'message', '信息不存在或已删除');
    END IF;
    v_status := CASE WHEN v_post.status = 'RECRUITING' AND v_post.expires_at <= p_now
      THEN 'EXPIRED' ELSE v_post.status END;
    IF p_action = 'getContact' THEN
      IF v_status <> 'RECRUITING' THEN
        RETURN jsonb_build_object('code', 'POST_UNAVAILABLE', 'message', '该信息已不在招募中');
      END IF;
      RETURN jsonb_build_object('code', 'OK', 'data', jsonb_build_object('gameId', v_post.game_id));
    END IF;
    v_owner := v_user.id IS NOT NULL AND v_user.id = v_post.owner_id;
    v_card := jsonb_build_object('id', v_post.id, 'modeCode', v_post.mode_code,
      'rankCode', v_post.rank_code, 'serverCode', v_post.server_code,
      'currentPlayers', v_post.current_players, 'maxPlayers', v_post.max_players,
      'remainingSlots', v_post.max_players - v_post.current_players,
      'note', v_post.note, 'status', v_status, 'createdAt', v_post.created_at,
      'expiresAt', v_post.expires_at, 'version', v_post.version,
      'updatedAt', v_post.updated_at, 'canEdit', v_owner AND v_status = 'RECRUITING',
      'canClose', v_owner AND v_status = 'RECRUITING', 'canDelete', v_owner);
    RETURN jsonb_build_object('code', 'OK', 'data', v_card);
  END IF;

  IF p_action IN ('listPosts', 'listMyPosts') THEN
    v_limit := (p_payload->>'limit')::integer;
    v_items := '[]'::jsonb;
    v_count := 0;
    FOR v_post IN
      SELECT * FROM apex_private.team_posts
      WHERE deleted_at IS NULL
        AND (p_action = 'listMyPosts' AND owner_id = v_user.id
          OR p_action = 'listPosts' AND status = 'RECRUITING' AND expires_at > p_now
            AND (p_payload->>'modeCode' IS NULL OR mode_code = p_payload->>'modeCode')
            AND (p_payload->>'rankCode' IS NULL OR rank_code IN (p_payload->>'rankCode', 'ANY'))
            AND (p_payload->>'serverCode' IS NULL OR server_code = p_payload->>'serverCode')
            AND (p_payload->>'remainingSlots' IS NULL
              OR current_players = 3 - (p_payload->>'remainingSlots')::integer))
        AND (p_payload->>'cursorTime' IS NULL
          OR (created_at, id) < ((p_payload->>'cursorTime')::timestamptz, p_payload->>'cursorId'))
      ORDER BY created_at DESC, id DESC LIMIT v_limit + 1
    LOOP
      v_count := v_count + 1;
      IF v_count > v_limit THEN EXIT; END IF;
      v_status := CASE WHEN v_post.status = 'RECRUITING' AND v_post.expires_at <= p_now
        THEN 'EXPIRED' ELSE v_post.status END;
      v_card := jsonb_build_object('id', v_post.id, 'modeCode', v_post.mode_code,
        'rankCode', v_post.rank_code, 'serverCode', v_post.server_code,
        'currentPlayers', v_post.current_players, 'maxPlayers', v_post.max_players,
        'remainingSlots', v_post.max_players - v_post.current_players,
        'note', v_post.note, 'status', v_status, 'createdAt', v_post.created_at,
        'expiresAt', v_post.expires_at, 'version', v_post.version);
      IF p_action = 'listMyPosts' THEN
        v_card := v_card || jsonb_build_object('updatedAt', v_post.updated_at,
          'canEdit', v_status = 'RECRUITING', 'canClose', v_status = 'RECRUITING',
          'canDelete', true, 'gameId', v_post.game_id);
      END IF;
      v_items := v_items || jsonb_build_array(v_card);
      v_last := jsonb_build_object('t', v_post.created_at, 'id', v_post.id);
    END LOOP;
    RETURN jsonb_build_object('code', 'OK', 'data', jsonb_build_object(
      'items', v_items, 'hasMore', v_count > v_limit,
      'nextPosition', CASE WHEN v_count > v_limit THEN v_last ELSE NULL END));
  END IF;

  RETURN jsonb_build_object('code', 'VALIDATION_ERROR', 'message', '未知接口');
END;
$$;

REVOKE EXECUTE ON FUNCTION public.apex_backend_call(text, text, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apex_backend_call(text, text, jsonb, timestamptz) TO service_role;
