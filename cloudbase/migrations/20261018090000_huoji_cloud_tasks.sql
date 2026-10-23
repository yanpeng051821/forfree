-- Additive task RPC wrapper. Apply after 20261017030424_huoji_core.sql.
-- No existing table or data is recreated. The original RPC body is renamed once,
-- kept byte-for-byte, and called for every operation outside this migration.
BEGIN;
SELECT pg_advisory_xact_lock(20261018, 90000);

CREATE TABLE IF NOT EXISTS public.huoji_uploads (
  upload_id text PRIMARY KEY CHECK (upload_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
  owner_id text NOT NULL REFERENCES public.huoji_users(id),
  kind text NOT NULL CHECK (kind IN ('workbook','photo')),
  object_key text NOT NULL UNIQUE,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  content_type text NOT NULL,
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 160),
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','committed','abandoned')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '10 minutes',
  CHECK (object_key = owner_id || CASE kind WHEN 'workbook' THEN '/uploads/' ELSE '/photos/' END || upload_id || CASE kind WHEN 'workbook' THEN '.xlsx' ELSE '.jpg' END),
  CHECK ((kind = 'workbook' AND size_bytes <= 41943040 AND content_type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    OR (kind = 'photo' AND size_bytes <= 8388608 AND content_type = 'image/jpeg'))
);
CREATE INDEX IF NOT EXISTS huoji_uploads_owner_state ON public.huoji_uploads(owner_id,state,expires_at);
CREATE TABLE IF NOT EXISTS public.huoji_jobs (
  job_id text PRIMARY KEY CHECK (job_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
  owner_id text NOT NULL REFERENCES public.huoji_users(id),
  kind text NOT NULL CHECK (kind IN ('workbook-import','workbook-export','product-export','extraction')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','succeeded','failed')),
  input jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  result_reference text,
  error jsonb,
  version int NOT NULL DEFAULT 0 CHECK (version >= 0),
  run_token text CHECK (run_token IS NULL OR run_token ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '5 minutes',
  CHECK ((state IN ('pending','running') AND result_reference IS NULL AND error IS NULL)
    OR (state = 'succeeded' AND result_reference IS NOT NULL AND error IS NULL)
    OR (state = 'failed' AND result_reference IS NULL AND jsonb_typeof(error) = 'object')),
  CHECK (state <> 'running' OR run_token IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS huoji_jobs_owner_state ON public.huoji_jobs(owner_id,state,expires_at);
ALTER TABLE public.huoji_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huoji_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.huoji_uploads, public.huoji_jobs FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.huoji_upload_ticket(p_ticket public.huoji_uploads)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT jsonb_build_object('uploadId',p_ticket.upload_id,'objectKey',p_ticket.object_key,'kind',p_ticket.kind,
    'sizeBytes',p_ticket.size_bytes,'sha256',p_ticket.sha256,'state',p_ticket.state,'createdAt',p_ticket.created_at,'expiresAt',p_ticket.expires_at);
$fn$;
CREATE OR REPLACE FUNCTION public.huoji_job_record(p_job public.huoji_jobs)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT jsonb_build_object('jobId',p_job.job_id,'kind',p_job.kind,'state',p_job.state,'resultReference',p_job.result_reference,
    'error',p_job.error,'version',p_job.version,'createdAt',p_job.created_at,'updatedAt',p_job.updated_at,'expiresAt',p_job.expires_at);
$fn$;

-- Validate the extraction JSON stored in resultReference, including every field.
-- No unknown keys, binary attachments, model diagnostics or arbitrary JSON objects.
CREATE OR REPLACE FUNCTION public.huoji_check_extraction(p_result text)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE doc jsonb; k text; v jsonb; max_length int; n numeric;
BEGIN
  IF p_result IS NULL OR octet_length(p_result) > 65536 THEN PERFORM public.huoji_fail('VALIDATION','整理结果过大或无效'); END IF;
  doc := p_result::jsonb;
  IF jsonb_typeof(doc) IS DISTINCT FROM 'object' OR doc - ARRAY['fields','mode','warning','estimates'] <> '{}'::jsonb
    OR jsonb_typeof(doc->'fields') IS DISTINCT FROM 'object' OR jsonb_typeof(doc->'mode') IS DISTINCT FROM 'string'
    OR doc->>'mode' NOT IN ('rules','model') OR jsonb_typeof(doc->'warning') IS DISTINCT FROM 'string'
    OR length(doc->>'warning') > 5000 THEN PERFORM public.huoji_fail('VALIDATION','整理结果格式无效'); END IF;
  IF doc ? 'estimates' THEN
    IF jsonb_typeof(doc->'estimates') IS DISTINCT FROM 'array' THEN PERFORM public.huoji_fail('VALIDATION','估算字段无效'); END IF;
    IF jsonb_array_length(doc->'estimates') > 30 OR EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'estimates') e WHERE jsonb_typeof(e) <> 'string' OR length(e #>> '{}') > 500) THEN
      PERFORM public.huoji_fail('VALIDATION','估算字段无效');
    END IF;
  END IF;
  FOR k,v IN SELECT * FROM jsonb_each(doc->'fields') LOOP
    IF k IN ('name','sku','supplier','supplierContact','colors','material','dimensions','cartonDimensions','tradeTerms','description','notes','evaluation') THEN
      max_length := CASE WHEN k IN ('name','sku') THEN 120 WHEN k = 'description' THEN 10000 WHEN k IN ('notes','evaluation') THEN 5000 ELSE 200 END;
      IF jsonb_typeof(v) <> 'string' OR length(v #>> '{}') > max_length OR (k = 'name' AND length(btrim(v #>> '{}')) = 0) THEN
        PERFORM public.huoji_fail('VALIDATION','整理文本字段无效');
      END IF;
    ELSIF k IN ('weightG','unitPrice','moq','cartonQty','cartonCbm','leadTimeDays','rating') THEN
      IF v = 'null'::jsonb THEN CONTINUE; END IF;
      IF jsonb_typeof(v) <> 'number' THEN PERFORM public.huoji_fail('VALIDATION','整理数值字段无效'); END IF;
      n := (v #>> '{}')::numeric;
      IF n < 0 OR n > 100000000 OR (k IN ('moq','cartonQty','leadTimeDays','rating') AND n <> trunc(n))
        OR (k = 'cartonQty' AND n < 1) OR (k = 'rating' AND n NOT BETWEEN 1 AND 5) THEN
        PERFORM public.huoji_fail('VALIDATION','整理数值字段无效');
      END IF;
    ELSIF k = 'currency' THEN
      IF jsonb_typeof(v) <> 'string' OR v #>> '{}' NOT IN ('CNY','USD','EUR') THEN PERFORM public.huoji_fail('VALIDATION','整理币种无效'); END IF;
    ELSIF k IN ('confirmed','favorite') THEN
      IF jsonb_typeof(v) <> 'boolean' THEN PERFORM public.huoji_fail('VALIDATION','整理标记无效'); END IF;
    ELSE PERFORM public.huoji_fail('VALIDATION','整理结果包含未知字段');
    END IF;
  END LOOP;
END $fn$;

DO $preserve$
BEGIN
  IF to_regprocedure('public.huoji_command_core_20261018(text,text,text,jsonb)') IS NULL THEN
    IF to_regprocedure('public.huoji_command(text,text,text,jsonb)') IS NULL THEN RAISE EXCEPTION 'Missing prerequisite huoji_command'; END IF;
    ALTER FUNCTION public.huoji_command(text,text,text,jsonb) RENAME TO huoji_command_core_20261018;
  ELSIF to_regprocedure('public.huoji_command(text,text,text,jsonb)') IS NOT NULL
    AND position('public.huoji_command_core_20261018(' in pg_get_functiondef('public.huoji_command(text,text,text,jsonb)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'Refusing to overwrite an unrecognized huoji_command; inspect the intervening migration';
  END IF;
END $preserve$;

CREATE OR REPLACE FUNCTION public.huoji_command(p_operation text, p_owner text, p_token_hash text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  op text := p_operation; id_value text; kind_value text; state_value text; key_value text;
  uuid_pattern text := '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$';
  ticket public.huoji_uploads%ROWTYPE; job public.huoji_jobs%ROWTYPE;
  input_value jsonb; error_value jsonb; reference_value text; version_value int; run_value text; size_value bigint;
  now_value timestamptz; result jsonb; date_value date;
BEGIN
  IF op NOT IN ('upload/prepare','upload/commit','upload/abandon','job/create','job/get','job/start','job/finish') OR op IS NULL THEN
    RETURN public.huoji_command_core_20261018(p_operation,p_owner,p_token_hash,p_payload);
  END IF;
  IF auth.role() IS DISTINCT FROM 'service_role' THEN PERFORM public.huoji_fail('FORBIDDEN','仅服务端可调用业务RPC',403); END IF;
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN PERFORM public.huoji_fail('VALIDATION','载荷必须是JSON对象'); END IF;
  IF octet_length(p_payload::text) > 4194304 THEN PERFORM public.huoji_fail('PAYLOAD_LIMIT','数据库请求过大',413); END IF;
  IF p_payload ?| ARRAY['owner','ownerId','owner_id'] THEN PERFORM public.huoji_fail('VALIDATION','业务载荷不能指定账号'); END IF;
  -- Same linearization point as the preserved core, including session revocation.
  PERFORM 1 FROM public.huoji_users WHERE id = p_owner FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.huoji_fail('LOGIN_REQUIRED','登录已过期或退出，请重新登录',401); END IF;
  now_value := clock_timestamp();
  IF NOT EXISTS(SELECT 1 FROM public.huoji_sessions WHERE owner_id = p_owner AND token_hash = p_token_hash AND expires_at > now_value) THEN
    PERFORM public.huoji_fail('LOGIN_REQUIRED','登录已过期或退出，请重新登录',401);
  END IF;
  id_value := p_payload->>CASE WHEN op LIKE 'upload/%' THEN 'uploadId' ELSE 'jobId' END;
  IF id_value IS NULL OR id_value !~ uuid_pattern THEN PERFORM public.huoji_fail('VALIDATION','任务或上传标识无效'); END IF;
  IF op = 'upload/prepare' AND NOT COALESCE(p_payload->'lookup' = 'true'::jsonb,false) THEN
    kind_value := p_payload->>'kind'; key_value := p_payload->>'objectKey';
    IF jsonb_typeof(p_payload->'sizeBytes') IS DISTINCT FROM 'number' OR (p_payload->>'sizeBytes')::numeric <> trunc((p_payload->>'sizeBytes')::numeric) THEN PERFORM public.huoji_fail('VALIDATION','上传大小无效'); END IF;
    size_value := (p_payload->>'sizeBytes')::bigint;
    IF kind_value IS NULL OR kind_value NOT IN ('workbook','photo') OR key_value IS DISTINCT FROM (p_owner || CASE kind_value WHEN 'workbook' THEN '/uploads/' ELSE '/photos/' END || id_value || CASE kind_value WHEN 'workbook' THEN '.xlsx' ELSE '.jpg' END) THEN
      PERFORM public.huoji_fail('INVALID_BLOB_KEY','上传对象归属无效');
    END IF;
    SELECT * INTO ticket FROM public.huoji_uploads WHERE upload_id = id_value;
    IF FOUND THEN
      IF ticket.owner_id <> p_owner THEN PERFORM public.huoji_fail('NOT_FOUND','上传凭证不存在',404); END IF;
      IF ticket.kind IS DISTINCT FROM kind_value OR ticket.object_key IS DISTINCT FROM key_value OR ticket.size_bytes IS DISTINCT FROM size_value
        OR ticket.content_type IS DISTINCT FROM p_payload->>'contentType' OR ticket.sha256 IS DISTINCT FROM p_payload->>'sha256' OR ticket.filename IS DISTINCT FROM p_payload->>'filename' THEN
        PERFORM public.huoji_fail('CONFLICT','上传编号对应的内容已变化',409);
      END IF;
    ELSE
      INSERT INTO public.huoji_uploads(upload_id,owner_id,kind,object_key,size_bytes,content_type,sha256,filename)
        VALUES(id_value,p_owner,kind_value,key_value,size_value,p_payload->>'contentType',p_payload->>'sha256',p_payload->>'filename') RETURNING * INTO ticket;
    END IF;
    IF ticket.state = 'prepared' AND ticket.expires_at <= now_value THEN
      UPDATE public.huoji_uploads SET state = 'abandoned' WHERE upload_id = id_value AND owner_id = p_owner RETURNING * INTO ticket;
    END IF;
    result := public.huoji_upload_ticket(ticket);
  ELSIF op LIKE 'upload/%' THEN
    SELECT * INTO ticket FROM public.huoji_uploads WHERE upload_id = id_value AND owner_id = p_owner FOR UPDATE;
    IF NOT FOUND THEN PERFORM public.huoji_fail('UPLOAD_NOT_FOUND','上传凭证不存在',404); END IF;
    IF ticket.state = 'prepared' AND ticket.expires_at <= now_value THEN
      UPDATE public.huoji_uploads SET state = 'abandoned' WHERE upload_id = id_value AND owner_id = p_owner RETURNING * INTO ticket;
      IF op = 'upload/commit' THEN
        -- Return an envelope rather than raising: keep expiry transition committed.
        RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','UPLOAD_EXPIRED','message','上传凭证已过期，请重新上传','status',410));
      END IF;
    END IF;
    IF op = 'upload/commit' THEN
      IF jsonb_typeof(p_payload->'sizeBytes') IS DISTINCT FROM 'number' OR (p_payload->>'sizeBytes')::numeric <> ticket.size_bytes OR p_payload->>'sha256' IS DISTINCT FROM ticket.sha256 THEN
        PERFORM public.huoji_fail('UPLOAD_MISMATCH','上传元信息与登记不一致');
      END IF;
      IF ticket.state = 'abandoned' THEN PERFORM public.huoji_fail('CONFLICT','上传凭证已作废',409); END IF;
      IF ticket.state = 'prepared' THEN
        UPDATE public.huoji_uploads SET state = 'committed' WHERE upload_id = id_value AND owner_id = p_owner AND state = 'prepared' RETURNING * INTO ticket;
      END IF;
    ELSIF op = 'upload/abandon' THEN
      IF ticket.state = 'committed' THEN PERFORM public.huoji_fail('CONFLICT','上传已确认，不能作废',409); END IF;
      UPDATE public.huoji_uploads SET state = 'abandoned' WHERE upload_id = id_value AND owner_id = p_owner RETURNING * INTO ticket;
    END IF;
    result := public.huoji_upload_ticket(ticket);
  ELSIF op = 'job/create' THEN
    kind_value := p_payload->>'kind'; input_value := p_payload->'input';
    IF kind_value IS NULL OR kind_value NOT IN ('workbook-import','workbook-export','product-export','extraction') OR p_payload->>'state' IS DISTINCT FROM 'pending'
      OR jsonb_typeof(input_value) IS DISTINCT FROM 'object' THEN PERFORM public.huoji_fail('VALIDATION','任务类型或初始状态无效'); END IF;
    IF kind_value = 'extraction' THEN
      IF input_value <> '{}'::jsonb THEN PERFORM public.huoji_fail('VALIDATION','整理任务不能存原始输入'); END IF;
    ELSIF kind_value = 'workbook-import' THEN
      IF input_value - ARRAY['objectKey','filename'] <> '{}'::jsonb OR jsonb_typeof(input_value->'filename') IS DISTINCT FROM 'string'
        OR length(input_value->>'filename') NOT BETWEEN 1 AND 160 THEN PERFORM public.huoji_fail('VALIDATION','导入输入无效'); END IF;
      IF NOT EXISTS(SELECT 1 FROM public.huoji_uploads WHERE owner_id = p_owner AND object_key = input_value->>'objectKey' AND kind = 'workbook' AND state = 'committed') THEN
        PERFORM public.huoji_fail('UPLOAD_NOT_COMMITTED','文件未完成上传确认，不能用于导入',409);
      END IF;
    ELSIF kind_value = 'workbook-export' THEN
      IF input_value - 'procurementId' <> '{}'::jsonb OR NOT EXISTS(SELECT 1 FROM public.huoji_procurement WHERE owner_id = p_owner AND id = input_value->>'procurementId') THEN
        PERFORM public.huoji_fail('NOT_FOUND','采购记录不存在或无权访问',404);
      END IF;
    ELSE
      IF input_value - ARRAY['projectId','date','scope','images','favorite','audience'] <> '{}'::jsonb
        OR (input_value ? 'scope' AND (jsonb_typeof(input_value->'scope') <> 'string' OR input_value->>'scope' NOT IN ('all','confirmed')))
        OR (input_value ? 'audience' AND (jsonb_typeof(input_value->'audience') <> 'string' OR input_value->>'audience' NOT IN ('selection','internal')))
        OR (input_value ? 'images' AND jsonb_typeof(input_value->'images') <> 'boolean')
        OR (input_value ? 'favorite' AND jsonb_typeof(input_value->'favorite') <> 'boolean') THEN
        PERFORM public.huoji_fail('VALIDATION','选品导出选项无效');
      END IF;
      IF input_value ? 'projectId' THEN
        IF NOT EXISTS(SELECT 1 FROM public.huoji_projects WHERE owner_id = p_owner AND id = input_value->>'projectId') THEN
          PERFORM public.huoji_fail('NOT_FOUND','看货任务不存在或无权访问',404);
        END IF;
      END IF;
      IF input_value ? 'date' THEN
        IF jsonb_typeof(input_value->'date') <> 'string' OR input_value->>'date' !~ '^\d{4}-\d{2}-\d{2}$' THEN PERFORM public.huoji_fail('VALIDATION','导出日期无效'); END IF;
        date_value := (input_value->>'date')::date;
        IF to_char(date_value,'YYYY-MM-DD') <> input_value->>'date' THEN PERFORM public.huoji_fail('VALIDATION','导出日期无效'); END IF;
      END IF;
      IF NOT (input_value ? 'projectId' OR input_value ? 'date' OR COALESCE(input_value->'favorite' = 'true'::jsonb,false)) THEN
        PERFORM public.huoji_fail('INVALID_SCOPE','请选择任务、日期或收藏');
      END IF;
    END IF;
    SELECT * INTO job FROM public.huoji_jobs WHERE job_id = id_value;
    IF FOUND THEN
      IF job.owner_id <> p_owner THEN PERFORM public.huoji_fail('NOT_FOUND','任务不存在',404); END IF;
      IF job.kind <> kind_value OR job.input <> input_value THEN PERFORM public.huoji_fail('CONFLICT','任务编号对应的内容已变化',409); END IF;
    ELSE
      IF (SELECT count(*) FROM public.huoji_jobs WHERE owner_id = p_owner AND state IN ('pending','running') AND expires_at > now_value) >= 20 THEN
        PERFORM public.huoji_fail('BUSY','任务过多，请稍后重试',429);
      END IF;
      INSERT INTO public.huoji_jobs(job_id,owner_id,kind,input) VALUES(id_value,p_owner,kind_value,input_value) RETURNING * INTO job;
    END IF;
    IF job.state IN ('pending','running') AND job.expires_at <= now_value THEN
      UPDATE public.huoji_jobs SET state = 'failed',error = '{"code":"JOB_EXPIRED","message":"任务已超时，请重新提交"}',version = version + 1,updated_at = now_value
        WHERE job_id = id_value AND owner_id = p_owner RETURNING * INTO job;
    END IF;
    result := public.huoji_job_record(job);
  ELSE
    SELECT * INTO job FROM public.huoji_jobs WHERE job_id = id_value AND owner_id = p_owner FOR UPDATE;
    IF NOT FOUND THEN PERFORM public.huoji_fail('NOT_FOUND','任务不存在或无权访问',404); END IF;
    IF job.state IN ('pending','running') AND job.expires_at <= now_value THEN
      UPDATE public.huoji_jobs SET state = 'failed',error = '{"code":"JOB_EXPIRED","message":"任务已超时，请重新提交"}',version = version + 1,updated_at = now_value
        WHERE job_id = id_value AND owner_id = p_owner RETURNING * INTO job;
      RETURN jsonb_build_object('ok',true,'data',public.huoji_job_record(job));
    END IF;
    IF op IN ('job/start','job/finish') THEN
      IF jsonb_typeof(p_payload->'expectedVersion') IS DISTINCT FROM 'number' OR (p_payload->>'expectedVersion')::numeric <> trunc((p_payload->>'expectedVersion')::numeric) THEN PERFORM public.huoji_fail('VALIDATION','任务版本无效'); END IF;
      version_value := (p_payload->>'expectedVersion')::int; run_value := p_payload->>'runToken';
      IF run_value IS NULL OR run_value !~ uuid_pattern THEN PERFORM public.huoji_fail('VALIDATION','任务执行凭证无效'); END IF;
      IF op = 'job/start' THEN
        IF job.state = 'running' AND job.run_token = run_value AND job.version = version_value + 1 THEN
          RETURN jsonb_build_object('ok',true,'data',public.huoji_job_record(job));
        END IF;
        IF job.state <> 'pending' OR job.version <> version_value THEN PERFORM public.huoji_fail('CONFLICT','任务已被执行或结束',409); END IF;
        UPDATE public.huoji_jobs SET state = 'running',run_token = run_value,version = version + 1,updated_at = now_value
          WHERE job_id = id_value AND owner_id = p_owner AND state = 'pending' AND version = version_value RETURNING * INTO job;
      ELSE
        state_value := p_payload->>'state'; reference_value := p_payload->>'resultReference'; error_value := p_payload->'error';
        IF error_value = 'null'::jsonb THEN error_value := NULL; END IF;
        IF state_value IS NULL OR state_value NOT IN ('succeeded','failed') THEN PERFORM public.huoji_fail('VALIDATION','任务结束状态无效'); END IF;
        IF state_value = 'succeeded' THEN
          IF reference_value IS NULL OR error_value IS NOT NULL THEN PERFORM public.huoji_fail('VALIDATION','成功任务必须有结果'); END IF;
          IF job.kind = 'extraction' THEN PERFORM public.huoji_check_extraction(reference_value);
          ELSIF job.kind = 'workbook-import' THEN
            IF NOT EXISTS(SELECT 1 FROM public.huoji_procurement WHERE owner_id = p_owner AND id = reference_value) THEN PERFORM public.huoji_fail('NOT_FOUND','导入结果不存在',404); END IF;
          ELSIF reference_value !~ ('^' || p_owner || '/exports/' || substr(uuid_pattern,2,length(uuid_pattern)-2) || '\.xlsx$') THEN
            PERFORM public.huoji_fail('INVALID_BLOB_KEY','导出结果归属无效');
          END IF;
        ELSE
          IF reference_value IS NOT NULL OR jsonb_typeof(error_value) IS DISTINCT FROM 'object' OR error_value - ARRAY['code','message'] <> '{}'::jsonb
            OR jsonb_typeof(error_value->'code') IS DISTINCT FROM 'string' OR error_value->>'code' !~ '^[A-Z][A-Z0-9_]{0,63}$'
            OR jsonb_typeof(error_value->'message') IS DISTINCT FROM 'string' OR length(error_value->>'message') NOT BETWEEN 1 AND 1000 THEN PERFORM public.huoji_fail('VALIDATION','任务错误格式无效'); END IF;
        END IF;
        IF job.state IN ('succeeded','failed') AND job.run_token = run_value AND job.version = version_value + 1
          AND job.state = state_value AND job.result_reference IS NOT DISTINCT FROM reference_value AND job.error IS NOT DISTINCT FROM error_value THEN
          RETURN jsonb_build_object('ok',true,'data',public.huoji_job_record(job));
        END IF;
        IF job.state <> 'running' OR job.version <> version_value OR job.run_token IS DISTINCT FROM run_value THEN PERFORM public.huoji_fail('CONFLICT','任务执行凭证或版本已失效',409); END IF;
        UPDATE public.huoji_jobs SET state = state_value,result_reference = reference_value,error = error_value,version = version + 1,updated_at = now_value
          WHERE job_id = id_value AND owner_id = p_owner AND state = 'running' AND version = version_value AND run_token = run_value RETURNING * INTO job;
      END IF;
    END IF;
    result := public.huoji_job_record(job);
  END IF;
  RETURN jsonb_build_object('ok',true,'data',result);
EXCEPTION
  WHEN SQLSTATE 'P0001' THEN RETURN jsonb_build_object('ok',false,'error',SQLERRM::jsonb);
  WHEN unique_violation OR serialization_failure OR deadlock_detected THEN
    RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','CONFLICT','message','任务或上传编号冲突，请重新读取后重试','status',409));
  WHEN check_violation OR not_null_violation OR foreign_key_violation OR invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN
    RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','VALIDATION','message','任务或上传数据无效','status',400));
END $fn$;

REVOKE ALL ON FUNCTION public.huoji_command_core_20261018(text,text,text,jsonb), public.huoji_upload_ticket(public.huoji_uploads),
  public.huoji_job_record(public.huoji_jobs), public.huoji_check_extraction(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.huoji_command(text,text,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.huoji_command(text,text,text,jsonb) TO service_role;
COMMIT;
