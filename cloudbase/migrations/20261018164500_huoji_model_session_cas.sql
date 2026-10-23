-- Add compare-and-swap to shared-model credentials; preserve every other core operation.
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('huoji-model-session-cas-20261018'));
DO $repair$
DECLARE signature regprocedure; definition text; fragment text; deadline_fragment text;
BEGIN
  signature := COALESCE(to_regprocedure('public.huoji_command_core_20261018(text,text,text,jsonb)'),to_regprocedure('public.huoji_command(text,text,text,jsonb)'));
  IF signature IS NULL THEN RAISE EXCEPTION 'Missing prerequisite huoji_command'; END IF;
  definition := pg_get_functiondef(signature);
  fragment := $patch$WHEN 'cloudSessionSave' THEN
      IF p_payload ? 'expectedEncrypted' AND s.cloud_encrypted IS DISTINCT FROM p_payload->>'expectedEncrypted' THEN
        PERFORM public.huoji_fail('MODEL_SESSION_CHANGED','AI登录已更新，请重试整理',409);
      END IF;$patch$;
  IF position('AI登录已更新，请重试整理' in definition) = 0 THEN
    IF position('WHEN ''cloudSessionSave'' THEN' in definition) = 0 THEN RAISE EXCEPTION 'Unrecognized cloud session implementation'; END IF;
    EXECUTE replace(definition, 'WHEN ''cloudSessionSave'' THEN', fragment);
  END IF;
  definition := pg_get_functiondef(signature);
  deadline_fragment := $deadline$WHEN 'cloudSessionSave' THEN
      IF p_payload ? 'deadlineAt' AND (p_payload->>'deadlineAt')::timestamptz <= clock_timestamp() THEN
        PERFORM public.huoji_fail('MODEL_RECOVERY_TIMEOUT','AI验证超时，输入已保留，请稍后重新整理',504);
      END IF;
$deadline$;
  IF position('AI验证超时，输入已保留，请稍后重新整理' in definition) = 0 THEN
    EXECUTE replace(definition, 'WHEN ''cloudSessionSave'' THEN', deadline_fragment);
  END IF;
END $repair$;
COMMIT;
