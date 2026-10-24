-- Run in the development SQL editor as administrator. Everything is rolled back.
BEGIN;
SET LOCAL ROLE service_role;

DO $$
DECLARE
  at_time timestamptz := '2026-10-24T21:00:00Z';
  form jsonb := '{"modeCode":"RANKED","rankCode":"GOLD","serverCode":"TEST_TOKYO","currentPlayers":1,"gameId":"SMOKE-ID","note":"smoke test"}'::jsonb;
  result jsonb;
  post_id text;
  next_id text;
BEGIN
  result := public.apex_backend_call('ensureUser', 'apex_smoke_a', '{}'::jsonb, at_time);
  IF result->>'code' <> 'OK' THEN RAISE EXCEPTION 'ensureUser A: %', result; END IF;
  result := public.apex_backend_call('ensureUser', 'apex_smoke_b', '{}'::jsonb, at_time);
  IF result->>'code' <> 'OK' THEN RAISE EXCEPTION 'ensureUser B: %', result; END IF;

  result := public.apex_backend_call('createPost', 'apex_smoke_a', form || '{"requestId":"smoke-1"}'::jsonb, at_time);
  IF result->>'code' <> 'OK' THEN RAISE EXCEPTION 'createPost: %', result; END IF;
  post_id := result->'data'->>'id';
  result := public.apex_backend_call('createPost', 'apex_smoke_a', form || '{"requestId":"smoke-1"}'::jsonb, at_time);
  IF result->'data'->>'id' <> post_id THEN RAISE EXCEPTION 'create retry: %', result; END IF;
  result := public.apex_backend_call('createPost', 'apex_smoke_a', form || '{"requestId":"smoke-2"}'::jsonb, at_time);
  IF result->>'code' <> 'ACTIVE_POST_EXISTS' THEN RAISE EXCEPTION 'second active post: %', result; END IF;

  result := public.apex_backend_call('listPosts', NULL, '{"limit":20,"modeCode":"RANKED","rankCode":"GOLD","serverCode":"TEST_TOKYO","remainingSlots":2}'::jsonb, at_time);
  IF jsonb_array_length(result->'data'->'items') <> 1 OR result::text LIKE '%SMOKE-ID%'
    THEN RAISE EXCEPTION 'public list or privacy: %', result; END IF;
  result := public.apex_backend_call('listPosts', NULL, '{"limit":20,"rankCode":"SILVER"}'::jsonb, at_time);
  IF jsonb_array_length(result->'data'->'items') <> 0 THEN RAISE EXCEPTION 'rank filter: %', result; END IF;
  result := public.apex_backend_call('getPost', 'apex_smoke_b', jsonb_build_object('postId',post_id), at_time);
  IF result->'data'->>'canEdit' <> 'false' OR result ? 'gameId' OR result->'data' ? 'gameId'
    THEN RAISE EXCEPTION 'public detail privacy: %', result; END IF;
  result := public.apex_backend_call('getContact', 'apex_smoke_b', jsonb_build_object('postId',post_id), at_time);
  IF result->'data'->>'gameId' <> 'SMOKE-ID' THEN RAISE EXCEPTION 'contact: %', result; END IF;
  result := public.apex_backend_call('listMyPosts', 'apex_smoke_a', '{"limit":20}'::jsonb, at_time);
  IF result->'data'->'items'->0->>'gameId' <> 'SMOKE-ID' THEN RAISE EXCEPTION 'owner list: %', result; END IF;
  result := public.apex_backend_call('createPost', 'apex_smoke_b', (form - 'gameId') || '{"requestId":"invalid"}'::jsonb, at_time);
  IF result->>'code' <> 'VALIDATION_ERROR' THEN RAISE EXCEPTION 'required field: %', result; END IF;
  result := public.apex_backend_call('createPost', 'apex_smoke_b', form || '{"requestId":"smoke-b1","rankCode":"SILVER"}'::jsonb, at_time + interval '1 second');
  IF result->>'code' <> 'OK' THEN RAISE EXCEPTION 'createPost B: %', result; END IF;
  result := public.apex_backend_call('listPosts', NULL, '{"limit":1}'::jsonb, at_time + interval '2 seconds');
  IF result->'data'->>'hasMore' <> 'true' OR jsonb_array_length(result->'data'->'items') <> 1
    THEN RAISE EXCEPTION 'first page: %', result; END IF;
  result := public.apex_backend_call('listPosts', NULL, '{"limit":1}'::jsonb || jsonb_build_object(
    'cursorTime', result->'data'->'nextPosition'->>'t', 'cursorId', result->'data'->'nextPosition'->>'id'), at_time + interval '2 seconds');
  IF result->'data'->'items'->0->>'id' <> post_id OR result->'data'->>'hasMore' <> 'false'
    THEN RAISE EXCEPTION 'second page: %', result; END IF;
  result := public.apex_backend_call('ensureUser', 'apex_smoke_c', '{}'::jsonb, at_time);
  result := public.apex_backend_call('createPost', 'apex_smoke_c', form || '{"requestId":"smoke-c1","rankCode":"ANY"}'::jsonb, at_time + interval '3 seconds');
  IF result->>'code' <> 'OK' THEN RAISE EXCEPTION 'create ANY rank: %', result; END IF;
  result := public.apex_backend_call('listPosts', NULL, '{"limit":20,"rankCode":"GOLD"}'::jsonb, at_time + interval '4 seconds');
  IF jsonb_array_length(result->'data'->'items') <> 2 THEN RAISE EXCEPTION 'ANY rank included: %', result; END IF;
  result := public.apex_backend_call('updatePost', 'apex_smoke_b', form || jsonb_build_object('postId',post_id,'version',1), at_time);
  IF result->>'code' <> 'FORBIDDEN' THEN RAISE EXCEPTION 'ownership: %', result; END IF;
  result := public.apex_backend_call('updatePost', 'apex_smoke_a', form || jsonb_build_object('postId',post_id,'version',2), at_time);
  IF result->>'code' <> 'VERSION_CONFLICT' THEN RAISE EXCEPTION 'stale version: %', result; END IF;

  result := public.apex_backend_call('updatePost', 'apex_smoke_a', form || jsonb_build_object('postId',post_id,'version',1,'currentPlayers',2), at_time);
  IF result->'data'->>'version' <> '2' OR result->'data'->>'status' <> 'RECRUITING'
    THEN RAISE EXCEPTION 'update to 2/3: %', result; END IF;
  result := public.apex_backend_call('updatePost', 'apex_smoke_a', form || jsonb_build_object('postId',post_id,'version',2,'currentPlayers',3), at_time);
  IF result->'data'->>'version' <> '3' OR result->'data'->>'status' <> 'FULL'
    THEN RAISE EXCEPTION 'update to 3/3: %', result; END IF;
  result := public.apex_backend_call('getContact', 'apex_smoke_b', jsonb_build_object('postId',post_id), at_time);
  IF result->>'code' <> 'POST_UNAVAILABLE' THEN RAISE EXCEPTION 'full post contact: %', result; END IF;
  result := public.apex_backend_call('ensureUser', 'apex_smoke_a', '{}'::jsonb, at_time);
  IF result->'data'->>'hasActivePost' <> 'false' THEN RAISE EXCEPTION 'full post active reference: %', result; END IF;

  result := public.apex_backend_call('createPost', 'apex_smoke_a', form || '{"requestId":"smoke-3"}'::jsonb, at_time);
  next_id := result->'data'->>'id';
  IF result->>'code' <> 'OK' OR next_id = post_id THEN RAISE EXCEPTION 'create after full: %', result; END IF;
  result := public.apex_backend_call('closePost', 'apex_smoke_a', jsonb_build_object('postId',next_id,'version',1), at_time);
  IF result->'data'->>'status' <> 'CLOSED' THEN RAISE EXCEPTION 'close: %', result; END IF;
  result := public.apex_backend_call('deletePost', 'apex_smoke_a', jsonb_build_object('postId',next_id,'version',2), at_time);
  IF result->>'code' <> 'OK' THEN RAISE EXCEPTION 'delete: %', result; END IF;
  result := public.apex_backend_call('getPost', NULL, jsonb_build_object('postId',next_id), at_time);
  IF result->>'code' <> 'NOT_FOUND' THEN RAISE EXCEPTION 'deleted detail: %', result; END IF;

  result := public.apex_backend_call('createPost', 'apex_smoke_a', form || '{"requestId":"smoke-4"}'::jsonb, at_time);
  next_id := result->'data'->>'id';
  result := public.apex_backend_call('deletePost', 'apex_smoke_a', jsonb_build_object('postId',post_id,'version',3), at_time);
  IF result->>'code' <> 'OK' THEN RAISE EXCEPTION 'delete older full post: %', result; END IF;
  result := public.apex_backend_call('ensureUser', 'apex_smoke_a', '{}'::jsonb, at_time);
  IF result->'data'->>'activePostId' <> next_id THEN RAISE EXCEPTION 'new active reference: %', result; END IF;
  result := public.apex_backend_call('getPost', NULL, jsonb_build_object('postId',next_id), at_time + interval '120 minutes');
  IF result->'data'->>'status' <> 'EXPIRED' THEN RAISE EXCEPTION 'expiry boundary: %', result; END IF;
  result := public.apex_backend_call('listPosts', NULL, '{"limit":20}'::jsonb, at_time + interval '121 minutes');
  IF jsonb_array_length(result->'data'->'items') <> 0 THEN RAISE EXCEPTION 'expired hall: %', result; END IF;
  result := public.apex_backend_call('getContact', 'apex_smoke_b', jsonb_build_object('postId',next_id), at_time + interval '120 minutes');
  IF result->>'code' <> 'POST_UNAVAILABLE' THEN RAISE EXCEPTION 'expired contact: %', result; END IF;
END $$;

ROLLBACK;
