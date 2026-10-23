-- 由主控应用。仅BFF的service_role可以调用；业务owner不是CloudBase JWT的sub。
-- 不依赖pgcrypto：sha256(bytea)及gen_random_uuid()由当前PG内置提供。
BEGIN;
CREATE TABLE public.huoji_users (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text CHECK (id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
  subject text NOT NULL UNIQUE CHECK (length(subject) BETWEEN 1 AND 512 AND subject <> '__legacy__'),
  profile jsonb NOT NULL DEFAULT '{"name":"","company":"","role":"buyer","phone":"","wechat":"","defaultCurrency":"CNY"}',
  profile_version int NOT NULL DEFAULT 0 CHECK (profile_version >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (jsonb_typeof(profile) = 'object')
);
CREATE TABLE public.huoji_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  owner_id text NOT NULL REFERENCES public.huoji_users(id),
  expires_at timestamptz NOT NULL,
  cloud_encrypted text,
  CHECK (cloud_encrypted IS NULL OR length(cloud_encrypted) BETWEEN 40 AND 100000)
);
CREATE INDEX huoji_sessions_owner ON public.huoji_sessions(owner_id);
CREATE INDEX huoji_sessions_expiry ON public.huoji_sessions(expires_at);
CREATE TABLE public.huoji_projects (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  owner_id text NOT NULL REFERENCES public.huoji_users(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  market text NOT NULL DEFAULT '' CHECK (length(market) <= 120),
  date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  demo bool NOT NULL DEFAULT false,
  UNIQUE(owner_id, id)
);
CREATE INDEX huoji_projects_owner_order ON public.huoji_projects(owner_id, created_at DESC, id DESC);
CREATE TABLE public.huoji_products (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  owner_id text NOT NULL REFERENCES public.huoji_users(id),
  project_id text NOT NULL,
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'object'),
  version int NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(owner_id, id),
  FOREIGN KEY(owner_id, project_id) REFERENCES public.huoji_projects(owner_id, id)
);
CREATE INDEX huoji_products_project_order ON public.huoji_products(owner_id, project_id, created_at DESC, id DESC);
CREATE INDEX huoji_products_owner_order ON public.huoji_products(owner_id, created_at DESC, id DESC);
CREATE INDEX huoji_products_favorites ON public.huoji_products(owner_id, created_at DESC, id DESC) WHERE fields->'favorite' = 'true'::jsonb;
CREATE TABLE public.huoji_media (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES public.huoji_users(id),
  product_id text,
  position int NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 5),
  name text NOT NULL CHECK (length(name) <= 200),
  object_key text NOT NULL UNIQUE,
  expires_at timestamptz,
  FOREIGN KEY(owner_id, product_id) REFERENCES public.huoji_products(owner_id, id),
  CHECK ((product_id IS NULL AND expires_at IS NOT NULL) OR (product_id IS NOT NULL AND expires_at IS NULL)),
  CHECK (object_key = owner_id || '/photos/' || id || '.jpg'),
  CHECK (id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')
);
CREATE UNIQUE INDEX huoji_media_position ON public.huoji_media(product_id, position) WHERE product_id IS NOT NULL;
CREATE INDEX huoji_media_owner_expiry ON public.huoji_media(owner_id, expires_at) WHERE product_id IS NULL;
CREATE TABLE public.huoji_receipts (
  owner_id text NOT NULL REFERENCES public.huoji_users(id),
  request_key text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 256),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL,
  PRIMARY KEY(owner_id, request_key)
);
CREATE TABLE public.huoji_procurement (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES public.huoji_users(id),
  version int NOT NULL CHECK (version > 0),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  source_hash text CHECK (source_hash IS NULL OR source_hash ~ '^[a-f0-9]{64}$'),
  original_key text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (document->>'id' = id AND (document->>'version')::int = version),
  CHECK (nullif(document->>'sourceHash', '') IS NOT DISTINCT FROM source_hash),
  CHECK (original_key IS NULL OR original_key ~ ('^' || owner_id || '/procurement/[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.xlsx$')),
  CHECK (id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')
);
CREATE UNIQUE INDEX huoji_procurement_source ON public.huoji_procurement(owner_id, source_hash) WHERE source_hash IS NOT NULL;
CREATE INDEX huoji_procurement_owner_order ON public.huoji_procurement(owner_id, updated_at DESC, id DESC);
CREATE TABLE public.huoji_templates (
  owner_id text PRIMARY KEY REFERENCES public.huoji_users(id),
  version int NOT NULL CHECK (version > 0),
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'object')
);

DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['huoji_users','huoji_sessions','huoji_projects','huoji_products','huoji_media','huoji_receipts','huoji_procurement','huoji_templates'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role', t);
  END LOOP;
END $rls$;

CREATE FUNCTION public.huoji_fail(p_code text, p_message text, p_status int DEFAULT 400)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = jsonb_build_object('code', p_code, 'message', p_message, 'status', p_status)::text;
END $fn$;

CREATE FUNCTION public.huoji_cursor(p_scope text, p_id text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $fn$
  SELECT rtrim(translate(replace(encode(sha256(convert_to(p_scope, 'UTF8') || decode('00','hex') || convert_to(p_id,'UTF8')), 'base64'), E'\n', ''), '+/', '-_'), '=');
$fn$;

-- 单条产品的照片在SQL内一次聚合，无客户端N+1 RPC。保留fields内未知键。
CREATE FUNCTION public.huoji_function_product(p_id text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT pr.fields || jsonb_build_object('id', pr.id, 'projectId', pr.project_id, 'version', pr.version,
    'createdAt', pr.created_at, 'updatedAt', pr.updated_at,
    'taskName', p.name, 'taskMarket', p.market, 'taskDate', p.date, 'demo', p.demo,
    'photos', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name) ORDER BY m.position)
      FROM public.huoji_media m WHERE m.owner_id = pr.owner_id AND m.product_id = pr.id), '[]'::jsonb))
  FROM public.huoji_products pr JOIN public.huoji_projects p ON p.id = pr.project_id AND p.owner_id = pr.owner_id WHERE pr.id = p_id;
$fn$;
CREATE FUNCTION public.huoji_summary(p_owner text, p_project text DEFAULT NULL, p_date date DEFAULT NULL, p_favorite bool DEFAULT false)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT jsonb_build_object('total', count(pr.id),
    'confirmed', count(*) FILTER (WHERE pr.fields->'confirmed' = 'true'::jsonb),
    'pending', count(*) FILTER (WHERE pr.fields->'confirmed' IS DISTINCT FROM 'true'::jsonb),
    'missingPrice', count(*) FILTER (WHERE pr.fields->>'unitPrice' IS NULL),
    'suppliers', count(DISTINCT nullif(btrim(pr.fields->>'supplier'), '')),
    'photos', COALESCE(sum((SELECT count(*) FROM public.huoji_media m WHERE m.owner_id = p_owner AND m.product_id = pr.id)),0))
  FROM public.huoji_products pr WHERE pr.owner_id = p_owner
    AND (p_project IS NULL OR pr.project_id = p_project)
    AND (p_date IS NULL OR (pr.created_at >= (p_date::timestamp AT TIME ZONE 'Asia/Shanghai') AND pr.created_at < ((p_date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai')))
    AND (NOT p_favorite OR pr.fields->'favorite' = 'true'::jsonb);
$fn$;
CREATE FUNCTION public.huoji_project(p_owner text, p_id text, p_summary bool DEFAULT false)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT jsonb_build_object('id', p.id, 'name', p.name, 'market', p.market, 'date', p.date, 'demo', p.demo, 'createdAt', p.created_at)
    || CASE WHEN p_summary THEN jsonb_build_object('summary', public.huoji_summary(p_owner,p.id)) ELSE '{}'::jsonb END
  FROM public.huoji_projects p WHERE p.owner_id = p_owner AND p.id = p_id;
$fn$;
CREATE FUNCTION public.huoji_media_json(p_id text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT jsonb_build_object('id',id,'name',name,'objectKey',object_key,'productId',product_id,'expiresAt',expires_at) FROM public.huoji_media WHERE id = p_id;
$fn$;
CREATE FUNCTION public.huoji_procurement_json(p_id text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT jsonb_build_object('document',document,'originalKey',original_key) FROM public.huoji_procurement WHERE id = p_id;
$fn$;
CREATE FUNCTION public.huoji_check_document(p_owner text, p_doc jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE line jsonb; image jsonb;
BEGIN
  IF jsonb_typeof(p_doc) IS DISTINCT FROM 'object' OR p_doc->>'format' IS DISTINCT FROM '1'
    OR jsonb_typeof(p_doc->'lines') IS DISTINCT FROM 'array' OR jsonb_typeof(p_doc->'suppliers') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_doc->'issues') IS DISTINCT FROM 'array' OR jsonb_typeof(p_doc->'skippedSheets') IS DISTINCT FROM 'array' THEN
    PERFORM public.huoji_fail('VALIDATION','采购元数据无效');
  END IF;
  IF jsonb_array_length(p_doc->'lines') > 500 THEN PERFORM public.huoji_fail('WORKBOOK_LIMIT','单次最多整理500条商品'); END IF;
  FOR line IN SELECT value FROM jsonb_array_elements(p_doc->'lines') LOOP
    IF jsonb_typeof(line) IS DISTINCT FROM 'object' OR jsonb_typeof(line->'images') IS DISTINCT FROM 'array' THEN
      PERFORM public.huoji_fail('VALIDATION','采购商品或图片无效');
    END IF;
    FOR image IN SELECT value FROM jsonb_array_elements(line->'images') LOOP
      IF jsonb_typeof(image) IS DISTINCT FROM 'string' OR (image #>> '{}') !~ ('^cloud:' || p_owner || '/pictures/[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.jpg$') THEN
        PERFORM public.huoji_fail('INVALID_PHOTO','采购图片归属无效；数据库不能存图片字节');
      END IF;
    END LOOP;
  END LOOP;
END $fn$;

CREATE FUNCTION public.huoji_command(p_operation text, p_owner text, p_token_hash text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
#variable_conflict use_variable
<<command>>
DECLARE
  u public.huoji_users%ROWTYPE; s public.huoji_sessions%ROWTYPE;
  pr public.huoji_products%ROWTYPE; m public.huoji_media%ROWTYPE; pc public.huoji_procurement%ROWTYPE;
  receipt public.huoji_receipts%ROWTYPE; tpl public.huoji_templates%ROWTYPE;
  result jsonb; doc jsonb; fields jsonb; item jsonb; keys jsonb;
  id text; project_id text; request_key text; digest_value text; subject_value text; scope text;
  cursor_value text; query_value text; status_value text; escaped_query text;
  version_value int; limit_value int; photo_count int; affected int; matched bigint;
  favorite_value bool; check_only bool; boundary_id text; boundary_time timestamptz;
  day_value date; now_value timestamptz := clock_timestamp(); expiry_value timestamptz;
  source_value text; original_value text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN PERFORM public.huoji_fail('FORBIDDEN','仅服务端可调用业务RPC',403); END IF;
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN PERFORM public.huoji_fail('VALIDATION','载荷必须是JSON对象'); END IF;
  IF octet_length(p_payload::text) > 4194304 THEN PERFORM public.huoji_fail('PAYLOAD_LIMIT','数据库请求过大',413); END IF;
  IF p_payload ?| ARRAY['owner','ownerId','owner_id'] THEN PERFORM public.huoji_fail('VALIDATION','业务载荷不能指定账号'); END IF;
  IF p_operation = 'health' THEN RETURN jsonb_build_object('ok',true,'data',jsonb_build_object('healthy',true)); END IF;
  IF p_operation = 'login' THEN
    subject_value := p_payload->>'subject'; expiry_value := (p_payload->>'expiresAt')::timestamptz;
    IF subject_value IS NULL OR length(subject_value) NOT BETWEEN 1 AND 512 OR subject_value = '__legacy__'
      OR COALESCE(p_payload->>'tokenHash','') !~ '^[a-f0-9]{64}$' OR expiry_value IS NULL OR expiry_value <= now_value OR expiry_value > now_value + interval '7 days 1 minute' THEN
      PERFORM public.huoji_fail('LOGIN_FAILED','身份或会话无效',401);
    END IF;
    INSERT INTO public.huoji_users(subject) VALUES(subject_value) ON CONFLICT(subject) DO NOTHING;
    SELECT * INTO u FROM public.huoji_users WHERE subject = subject_value FOR UPDATE;
    INSERT INTO public.huoji_sessions(token_hash,owner_id,expires_at,cloud_encrypted) VALUES(p_payload->>'tokenHash',u.id,expiry_value,p_payload->>'cloudEncrypted');
    result := jsonb_build_object('owner',u.id,'tokenHash',p_payload->>'tokenHash','expiresAt',expiry_value,'profile',u.profile || jsonb_build_object('version',u.profile_version));
  ELSIF p_operation = 'sessionAuthenticate' THEN
    SELECT * INTO s FROM public.huoji_sessions WHERE token_hash = p_payload->>'tokenHash' AND expires_at > clock_timestamp();
    IF NOT FOUND THEN PERFORM public.huoji_fail('LOGIN_REQUIRED','登录已过期或退出，请重新登录',401); END IF;
    result := jsonb_build_object('owner',s.owner_id,'tokenHash',s.token_hash,'expiresAt',s.expires_at);
  ELSE
    -- 所有操作先锁用户行：撤销、配额、回执、CAS及媒体归属共享同一线性化点。
    SELECT * INTO u FROM public.huoji_users WHERE huoji_users.id = p_owner FOR UPDATE;
    IF NOT FOUND THEN PERFORM public.huoji_fail('LOGIN_REQUIRED','登录已过期或退出，请重新登录',401); END IF;
    SELECT * INTO s FROM public.huoji_sessions WHERE owner_id = p_owner AND token_hash = p_token_hash AND expires_at > clock_timestamp();
    IF NOT FOUND THEN PERFORM public.huoji_fail('LOGIN_REQUIRED','登录已过期或退出，请重新登录',401); END IF;
    id := p_payload->>'id'; fields := p_payload->'fields';
    version_value := (p_payload->>'version')::int;
    IF p_operation IN ('projects/create','product/save') THEN
      request_key := p_payload->>'requestKey';
      IF COALESCE(request_key,'') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN PERFORM public.huoji_fail('VALIDATION','请求编号无效'); END IF;
      -- 不信任客户端digest：由SQL对操作名和规范jsonb重新计算，checkOnly不影响回执。
      digest_value := encode(sha256(convert_to(p_operation || ':' || (p_payload - 'digest' - 'checkOnly')::text,'UTF8')),'hex');
    ELSIF p_operation IN ('product/delete','procurement/delete','procurement/update','template/save') THEN
      IF version_value IS NULL OR version_value < 0 THEN PERFORM public.huoji_fail('VALIDATION','版本无效'); END IF;
      request_key := p_operation || ':' || COALESCE(id,'') || ':' || version_value::text;
      doc := p_payload->'document';
      digest_value := encode(sha256(convert_to(p_operation || ':' ||
        CASE WHEN p_operation = 'procurement/update' THEN (p_payload - 'document' || jsonb_build_object('document',doc - 'version' - 'updatedAt'))::text ELSE p_payload::text END,'UTF8')),'hex');
    END IF;
    IF request_key IS NOT NULL THEN
      SELECT * INTO receipt FROM public.huoji_receipts WHERE owner_id = p_owner AND huoji_receipts.request_key = command.request_key;
      IF FOUND THEN
        IF receipt.digest <> digest_value THEN PERFORM public.huoji_fail('CONFLICT','同一请求编号对应的内容已变化，请重新提交',409); END IF;
        RETURN jsonb_build_object('ok',true,'data',receipt.result);
      END IF;
    END IF;
    check_only := COALESCE((p_payload->>'checkOnly')::bool,false);
    IF p_operation = 'product/save' AND check_only THEN RETURN jsonb_build_object('ok',true,'data',NULL); END IF;

    CASE p_operation
    WHEN 'sessionRevoke' THEN
      DELETE FROM public.huoji_sessions WHERE token_hash = p_token_hash AND owner_id = p_owner;
      result := jsonb_build_object('revoked',true);
    WHEN 'cloudSessionLoad' THEN
      result := jsonb_build_object('subject',u.subject,'encrypted',s.cloud_encrypted);
    WHEN 'cloudSessionSave' THEN
      IF p_payload ? 'deadlineAt' AND (p_payload->>'deadlineAt')::timestamptz <= clock_timestamp() THEN
        PERFORM public.huoji_fail('MODEL_RECOVERY_TIMEOUT','AI验证超时，输入已保留，请稍后重新整理',504);
      END IF;
      IF p_payload ? 'expectedEncrypted' AND s.cloud_encrypted IS DISTINCT FROM p_payload->>'expectedEncrypted' THEN
        PERFORM public.huoji_fail('MODEL_SESSION_CHANGED','AI登录已更新，请重试整理',409);
      END IF;
      IF COALESCE(p_payload->>'encrypted','') !~ '^[A-Za-z0-9+/]+={0,2}$' OR length(p_payload->>'encrypted') NOT BETWEEN 40 AND 100000 OR s.cloud_encrypted IS NULL THEN
        PERFORM public.huoji_fail('LOGIN_REQUIRED','共享服务会话不可用，请重新登录',401);
      END IF;
      UPDATE public.huoji_sessions SET cloud_encrypted = p_payload->>'encrypted' WHERE owner_id = p_owner AND token_hash = p_token_hash;
      result := jsonb_build_object('saved',true);
    WHEN 'getProfile' THEN result := u.profile || jsonb_build_object('version',u.profile_version);
    WHEN 'saveProfile' THEN
      IF jsonb_typeof(fields) IS DISTINCT FROM 'object' OR version_value IS NULL OR version_value < 0 THEN PERFORM public.huoji_fail('VALIDATION','个人资料或版本无效'); END IF;
      IF u.profile IS DISTINCT FROM fields THEN
        IF u.profile_version <> version_value THEN PERFORM public.huoji_fail('CONFLICT','个人资料已在其他设备更新，请重新打开后修改',409); END IF;
        UPDATE public.huoji_users SET profile = fields, profile_version = profile_version + 1 WHERE huoji_users.id = p_owner AND profile_version = version_value RETURNING * INTO u;
      END IF;
      result := u.profile || jsonb_build_object('version',u.profile_version);
    WHEN 'projects/list' THEN
      SELECT COALESCE(jsonb_agg(public.huoji_project(p_owner,p.id,true) ORDER BY p.created_at DESC,p.id DESC),'[]'::jsonb) INTO result FROM public.huoji_projects p WHERE p.owner_id = p_owner;
    WHEN 'projects/get' THEN
      result := public.huoji_project(p_owner,id);
      IF result IS NULL THEN PERFORM public.huoji_fail('NOT_FOUND','记录不存在或无权访问',404); END IF;
    WHEN 'projects/create' THEN
      IF COALESCE(p_payload->>'date','') !~ '^\d{4}-\d{2}-\d{2}$' THEN PERFORM public.huoji_fail('VALIDATION','日期无效'); END IF;
      day_value := (p_payload->>'date')::date;
      INSERT INTO public.huoji_projects(owner_id,name,market,date) VALUES(p_owner,p_payload->>'name',COALESCE(p_payload->>'market',''),day_value) RETURNING huoji_projects.id INTO id;
      result := public.huoji_project(p_owner,id);
    WHEN 'product/get' THEN
      IF NOT EXISTS(SELECT 1 FROM public.huoji_products p WHERE p.owner_id = p_owner AND p.id = id) THEN PERFORM public.huoji_fail('NOT_FOUND','记录不存在或无权访问',404); END IF;
      result := public.huoji_function_product(id);
    WHEN 'product/save' THEN
      project_id := p_payload->>'projectId';
      IF NOT EXISTS(SELECT 1 FROM public.huoji_projects p WHERE p.owner_id = p_owner AND p.id = project_id) THEN PERFORM public.huoji_fail('NOT_FOUND','任务不存在或无权访问',404); END IF;
      IF jsonb_typeof(fields) IS DISTINCT FROM 'object' OR jsonb_typeof(p_payload->'photoIds') IS DISTINCT FROM 'array' THEN PERFORM public.huoji_fail('VALIDATION','商品或照片载荷无效'); END IF;
      photo_count := jsonb_array_length(p_payload->'photoIds');
      IF photo_count > 6 OR photo_count <> (SELECT count(DISTINCT value) FROM jsonb_array_elements(p_payload->'photoIds'))
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'photoIds') WHERE jsonb_typeof(value) <> 'string') THEN
        PERFORM public.huoji_fail('INVALID_PHOTO','每件商品最多6张不重复的照片');
      END IF;
      IF id IS NOT NULL THEN
        SELECT * INTO pr FROM public.huoji_products p WHERE p.owner_id = p_owner AND p.id = id AND p.project_id = project_id;
        IF NOT FOUND THEN PERFORM public.huoji_fail('NOT_FOUND','记录不存在或无权访问',404); END IF;
        IF version_value IS NULL OR pr.version <> version_value THEN PERFORM public.huoji_fail('CONFLICT','记录已更新，请重新读取后再修改',409); END IF;
      ELSIF version_value IS NOT NULL THEN PERFORM public.huoji_fail('VALIDATION','新建商品不能提供版本');
      END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(p_payload->'photoIds') LOOP
        SELECT * INTO m FROM public.huoji_media WHERE owner_id = p_owner AND huoji_media.id = (item #>> '{}') AND (expires_at IS NULL OR expires_at > clock_timestamp());
        IF NOT FOUND THEN PERFORM public.huoji_fail('NOT_FOUND','照片不存在或已过期',404); END IF;
        IF m.product_id IS NOT NULL AND m.product_id IS DISTINCT FROM id THEN PERFORM public.huoji_fail('INVALID_PHOTO','照片归属无效'); END IF;
      END LOOP;
      IF id IS NULL THEN
        INSERT INTO public.huoji_products(owner_id,project_id,fields) VALUES(p_owner,project_id,fields) RETURNING huoji_products.id INTO id;
      ELSE
        UPDATE public.huoji_products SET fields = command.fields, version = version + 1, updated_at = clock_timestamp() WHERE owner_id = p_owner AND huoji_products.id = command.id AND version = version_value;
        GET DIAGNOSTICS affected = ROW_COUNT;
        IF affected <> 1 THEN PERFORM public.huoji_fail('CONFLICT','记录已更新',409); END IF;
      END IF;
      UPDATE public.huoji_media SET product_id = NULL, expires_at = clock_timestamp() + interval '24 hours' WHERE owner_id = p_owner AND product_id = id;
      UPDATE public.huoji_media photo_row SET product_id = command.id, position = (photo.ordinality - 1)::int, expires_at = NULL
        FROM jsonb_array_elements_text(p_payload->'photoIds') WITH ORDINALITY AS photo(photo_id,ordinality) WHERE photo_row.owner_id = p_owner AND photo_row.id = photo.photo_id;
      result := public.huoji_function_product(id);
    WHEN 'product/delete' THEN
      SELECT * INTO pr FROM public.huoji_products p WHERE p.owner_id = p_owner AND p.id = id;
      IF NOT FOUND THEN PERFORM public.huoji_fail('NOT_FOUND','记录不存在或无权访问',404); END IF;
      IF pr.version IS DISTINCT FROM version_value THEN PERFORM public.huoji_fail('CONFLICT','记录已更新',409); END IF;
      UPDATE public.huoji_media SET product_id = NULL, expires_at = clock_timestamp() WHERE owner_id = p_owner AND product_id = id;
      DELETE FROM public.huoji_products WHERE owner_id = p_owner AND huoji_products.id = command.id AND version = version_value;
      result := jsonb_build_object('deleted',true);
    WHEN 'product/favorite' THEN
      SELECT * INTO pr FROM public.huoji_products p WHERE p.owner_id = p_owner AND p.id = id;
      IF NOT FOUND THEN PERFORM public.huoji_fail('NOT_FOUND','记录不存在或无权访问',404); END IF;
      IF jsonb_typeof(p_payload->'favorite') IS DISTINCT FROM 'boolean' OR version_value IS NULL THEN PERFORM public.huoji_fail('VALIDATION','收藏或版本无效'); END IF;
      IF COALESCE(pr.fields->'favorite','false'::jsonb) IS DISTINCT FROM p_payload->'favorite' THEN
        IF pr.version <> version_value THEN PERFORM public.huoji_fail('CONFLICT','商品已更新，请刷新后重新收藏',409); END IF;
        UPDATE public.huoji_products SET fields = jsonb_set(pr.fields,'{favorite}',p_payload->'favorite'), version = version + 1, updated_at = clock_timestamp() WHERE owner_id = p_owner AND huoji_products.id = command.id AND version = version_value;
      END IF;
      result := public.huoji_function_product(id);
    WHEN 'recordDays' THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('date',d.day,'count',d.n) ORDER BY d.day DESC),'[]'::jsonb) INTO result
        FROM (SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date AS day, count(*) AS n FROM public.huoji_products WHERE owner_id = p_owner GROUP BY 1) d;
    WHEN 'media/stage' THEN
      IF (SELECT count(*) FROM public.huoji_media WHERE owner_id = p_owner AND product_id IS NULL) >= 100 THEN PERFORM public.huoji_fail('MEDIA_QUOTA','待保存照片过多，请保存商品或等待过期照片清理',429); END IF;
      INSERT INTO public.huoji_media(id,owner_id,name,object_key,expires_at) VALUES(id,p_owner,p_payload->>'name',p_payload->>'objectKey',clock_timestamp() + interval '24 hours');
      result := public.huoji_media_json(id);
    WHEN 'media/get' THEN
      IF NOT EXISTS(SELECT 1 FROM public.huoji_media WHERE owner_id = p_owner AND huoji_media.id = command.id AND (expires_at IS NULL OR expires_at > clock_timestamp())) THEN PERFORM public.huoji_fail('NOT_FOUND','照片不存在或已过期',404); END IF;
      result := public.huoji_media_json(id);
    WHEN 'media/listExpired' THEN
      limit_value := COALESCE((p_payload->>'limit')::int,100);
      IF limit_value NOT BETWEEN 1 AND 1000 THEN PERFORM public.huoji_fail('VALIDATION','清理数量无效'); END IF;
      SELECT COALESCE(jsonb_agg(public.huoji_media_json(e.id)),'[]'::jsonb) INTO result FROM
        (SELECT huoji_media.id FROM public.huoji_media WHERE owner_id = p_owner AND product_id IS NULL AND expires_at <= clock_timestamp() ORDER BY expires_at,huoji_media.id LIMIT limit_value) e;
    WHEN 'media/retire' THEN
      SELECT * INTO m FROM public.huoji_media WHERE owner_id = p_owner AND huoji_media.id = command.id;
      IF NOT FOUND THEN PERFORM public.huoji_fail('NOT_FOUND','照片不存在',404); END IF;
      IF m.product_id IS NOT NULL THEN PERFORM public.huoji_fail('CONFLICT','照片仍被商品引用',409); END IF;
      IF COALESCE((p_payload->>'purge')::bool,false) THEN
        IF m.expires_at > clock_timestamp() THEN PERFORM public.huoji_fail('CONFLICT','照片尚未过期',409); END IF;
        DELETE FROM public.huoji_media WHERE owner_id = p_owner AND huoji_media.id = command.id;
      ELSE UPDATE public.huoji_media SET expires_at = clock_timestamp() WHERE owner_id = p_owner AND huoji_media.id = command.id;
      END IF;
      result := jsonb_build_object('retired',true);
    WHEN 'procurement/list' THEN
      SELECT COALESCE(jsonb_agg(document ORDER BY updated_at DESC,huoji_procurement.id DESC),'[]'::jsonb) INTO result FROM public.huoji_procurement WHERE owner_id = p_owner;
    WHEN 'procurement/get' THEN
      IF NOT EXISTS(SELECT 1 FROM public.huoji_procurement WHERE owner_id = p_owner AND huoji_procurement.id = command.id) THEN PERFORM public.huoji_fail('NOT_FOUND','记录不存在或无权访问',404); END IF;
      result := public.huoji_procurement_json(id);
    WHEN 'procurement/create' THEN
      doc := p_payload->'document'; PERFORM public.huoji_check_document(p_owner,doc);
      source_value := nullif(doc->>'sourceHash',''); id := doc->>'id'; original_value := p_payload->>'originalKey';
      IF source_value IS NOT NULL THEN
        SELECT * INTO pc FROM public.huoji_procurement WHERE owner_id = p_owner AND source_hash = source_value;
        IF FOUND THEN RETURN jsonb_build_object('ok',true,'data',public.huoji_procurement_json(pc.id)); END IF;
      END IF;
      SELECT * INTO pc FROM public.huoji_procurement WHERE owner_id = p_owner AND huoji_procurement.id = command.id;
      IF FOUND THEN
        IF (pc.document - 'version' - 'updatedAt') = (doc - 'version' - 'updatedAt') THEN
          RETURN jsonb_build_object('ok',true,'data',public.huoji_procurement_json(pc.id));
        END IF;
        PERFORM public.huoji_fail('CONFLICT','整理记录编号已存在且内容不同',409);
      END IF;
      IF (SELECT count(*) FROM public.huoji_procurement WHERE owner_id = p_owner) >= 30 THEN PERFORM public.huoji_fail('PROCUREMENT_LIMIT','最多保留30份整理记录，请先删除不用的记录'); END IF;
      doc := doc || jsonb_build_object('version',1);
      INSERT INTO public.huoji_procurement(id,owner_id,version,document,source_hash,original_key,updated_at) VALUES(id,p_owner,1,doc,source_value,original_value,(doc->>'updatedAt')::timestamptz);
      result := public.huoji_procurement_json(id);
    WHEN 'procurement/update' THEN
      SELECT * INTO pc FROM public.huoji_procurement WHERE owner_id = p_owner AND huoji_procurement.id = command.id;
      IF NOT FOUND THEN PERFORM public.huoji_fail('NOT_FOUND','记录不存在或无权访问',404); END IF;
      doc := p_payload->'document'; PERFORM public.huoji_check_document(p_owner,doc);
      IF doc->>'id' IS DISTINCT FROM id OR doc->>'sourceHash' IS DISTINCT FROM pc.document->>'sourceHash' OR doc->>'createdAt' IS DISTINCT FROM pc.document->>'createdAt' THEN PERFORM public.huoji_fail('VALIDATION','采购来源和标识不能修改'); END IF;
      IF pc.version IS DISTINCT FROM version_value THEN PERFORM public.huoji_fail('CONFLICT','整理记录已更新，请重新打开后修改',409); END IF;
      doc := doc || jsonb_build_object('version',pc.version + 1,'updatedAt',clock_timestamp());
      UPDATE public.huoji_procurement SET version = version + 1, document = doc, updated_at = (doc->>'updatedAt')::timestamptz WHERE owner_id = p_owner AND huoji_procurement.id = command.id AND version = version_value;
      result := public.huoji_procurement_json(id);
    WHEN 'procurement/delete' THEN
      SELECT * INTO pc FROM public.huoji_procurement WHERE owner_id = p_owner AND huoji_procurement.id = command.id;
      IF NOT FOUND THEN PERFORM public.huoji_fail('NOT_FOUND','记录不存在或无权访问',404); END IF;
      IF pc.version IS DISTINCT FROM version_value THEN PERFORM public.huoji_fail('CONFLICT','记录已更新',409); END IF;
      SELECT COALESCE(jsonb_agg(DISTINCT to_jsonb(image #>> '{}')),'[]'::jsonb) INTO keys
        FROM jsonb_array_elements(pc.document->'lines') line CROSS JOIN LATERAL jsonb_array_elements(line->'images') image;
      keys := COALESCE((SELECT jsonb_agg(to_jsonb(substr(value #>> '{}',7))) FROM jsonb_array_elements(keys)),'[]'::jsonb);
      IF pc.original_key IS NOT NULL THEN keys := keys || jsonb_build_array(pc.original_key); END IF;
      DELETE FROM public.huoji_procurement WHERE owner_id = p_owner AND huoji_procurement.id = command.id AND version = version_value;
      result := jsonb_build_object('deleted',true,'objectKeys',keys);
    WHEN 'template/get' THEN
      SELECT huoji_templates.fields || jsonb_build_object('version',version) INTO result FROM public.huoji_templates WHERE owner_id = p_owner;
    WHEN 'template/save' THEN
      IF jsonb_typeof(fields) IS DISTINCT FROM 'object' OR version_value IS NULL OR version_value < 0 THEN PERFORM public.huoji_fail('VALIDATION','模板或版本无效'); END IF;
      SELECT * INTO tpl FROM public.huoji_templates WHERE owner_id = p_owner;
      IF COALESCE(tpl.version,0) <> version_value THEN PERFORM public.huoji_fail('CONFLICT','表格设置已更新，请重新打开后修改',409); END IF;
      INSERT INTO public.huoji_templates(owner_id,version,fields) VALUES(p_owner,version_value + 1,fields) ON CONFLICT(owner_id) DO UPDATE SET version = EXCLUDED.version,fields = EXCLUDED.fields;
      result := fields || jsonb_build_object('version',version_value + 1);
    WHEN 'product/page', 'product/listExport' THEN
      project_id := nullif(p_payload->>'projectId',''); day_value := (p_payload->>'date')::date;
      favorite_value := COALESCE((p_payload->>'favorite')::bool,false); limit_value := COALESCE((p_payload->>'limit')::int,30);
      IF project_id IS NULL AND day_value IS NULL AND NOT favorite_value THEN PERFORM public.huoji_fail('INVALID_SCOPE','请选择任务、日期或收藏'); END IF;
      IF project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.huoji_projects p WHERE p.owner_id = p_owner AND p.id = project_id) THEN PERFORM public.huoji_fail('NOT_FOUND','任务不存在或无权访问',404); END IF;
      IF limit_value NOT BETWEEN 1 AND 100 THEN PERFORM public.huoji_fail('VALIDATION','分页数量无效'); END IF;
      scope := COALESCE(project_id,'all') || CASE WHEN day_value IS NOT NULL THEN ':' || day_value::text ELSE '' END || CASE WHEN favorite_value THEN ':favorites' ELSE '' END;
      cursor_value := p_payload->>'cursor';
      IF cursor_value IS NOT NULL THEN
        IF cursor_value !~ '^[A-Za-z0-9_-]{43}$' THEN PERFORM public.huoji_fail('INVALID_CURSOR','分页游标无效'); END IF;
        SELECT p.id,p.created_at INTO boundary_id,boundary_time FROM public.huoji_products p WHERE p.owner_id = p_owner AND (project_id IS NULL OR p.project_id = command.project_id)
          AND (day_value IS NULL OR (p.created_at >= (day_value::timestamp AT TIME ZONE 'Asia/Shanghai') AND p.created_at < ((day_value + 1)::timestamp AT TIME ZONE 'Asia/Shanghai')))
          AND (NOT favorite_value OR p.fields->'favorite' = 'true'::jsonb) AND public.huoji_cursor(scope,p.id) = cursor_value;
        IF NOT FOUND THEN PERFORM public.huoji_fail('INVALID_CURSOR','分页游标无效'); END IF;
      END IF;
      query_value := COALESCE(p_payload->>'q',''); status_value := COALESCE(p_payload->>'status','all');
      IF status_value NOT IN ('all','pending','confirmed','missingPrice') OR length(query_value) > 200 THEN PERFORM public.huoji_fail('VALIDATION','搜索或状态无效'); END IF;
      -- LIKE的转义只用于字面匹配，不允许用户的%/_/反斜杠成为模式。
      escaped_query := '%' || replace(replace(replace(lower(query_value),E'\\',E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%';
      WITH base AS MATERIALIZED (
        SELECT p.* FROM public.huoji_products p WHERE p.owner_id = p_owner AND (project_id IS NULL OR p.project_id = command.project_id)
          AND (day_value IS NULL OR (p.created_at >= (day_value::timestamp AT TIME ZONE 'Asia/Shanghai') AND p.created_at < ((day_value + 1)::timestamp AT TIME ZONE 'Asia/Shanghai')))
          AND (NOT favorite_value OR p.fields->'favorite' = 'true'::jsonb)
      ), filtered AS MATERIALIZED (
        SELECT b.* FROM base b WHERE p_operation = 'product/listExport' OR (
          (status_value = 'all' OR (status_value = 'confirmed' AND b.fields->'confirmed' = 'true'::jsonb)
            OR (status_value = 'pending' AND b.fields->'confirmed' IS DISTINCT FROM 'true'::jsonb)
            OR (status_value = 'missingPrice' AND b.fields->>'unitPrice' IS NULL))
          AND (query_value = '' OR EXISTS(SELECT 1 FROM unnest(ARRAY['name','sku','supplier','supplierContact','description','notes','evaluation']) k WHERE lower(COALESCE(b.fields->>k,'')) LIKE escaped_query ESCAPE E'\\')))
      ), page AS (
        SELECT f.id,f.created_at FROM filtered f WHERE boundary_id IS NULL OR (f.created_at,f.id) < (boundary_time,boundary_id)
        ORDER BY f.created_at DESC,f.id DESC LIMIT CASE WHEN p_operation = 'product/listExport' THEN NULL ELSE limit_value + 1 END
      ) SELECT COALESCE(jsonb_agg(jsonb_build_object('id',page.id,'product',public.huoji_function_product(page.id)) ORDER BY page.created_at DESC,page.id DESC),'[]'::jsonb), (SELECT count(*) FROM filtered) INTO keys,matched FROM page;
      IF p_operation = 'product/listExport' THEN
        SELECT COALESCE(jsonb_agg(value->'product' ORDER BY ord),'[]'::jsonb) INTO result FROM jsonb_array_elements(keys) WITH ORDINALITY AS e(value,ord);
      ELSE
        SELECT COALESCE(jsonb_agg(value->'product' ORDER BY ord),'[]'::jsonb) INTO result FROM jsonb_array_elements(keys) WITH ORDINALITY AS e(value,ord) WHERE ord <= limit_value;
        result := jsonb_build_object('items',result,'summary',public.huoji_summary(p_owner,project_id,day_value,favorite_value),'matchedCount',matched,
          'nextCursor',CASE WHEN jsonb_array_length(keys) > limit_value THEN public.huoji_cursor(scope,keys->(limit_value - 1)->>'id') ELSE NULL END);
      END IF;
    ELSE PERFORM public.huoji_fail('UNKNOWN_OPERATION','不支持的业务操作');
    END CASE;
    IF request_key IS NOT NULL THEN
      INSERT INTO public.huoji_receipts(owner_id,request_key,digest,result) VALUES(p_owner,request_key,digest_value,result);
    END IF;
  END IF;
  RETURN jsonb_build_object('ok',true,'data',result);
EXCEPTION
  WHEN SQLSTATE 'P0001' THEN RETURN jsonb_build_object('ok',false,'error',SQLERRM::jsonb);
  WHEN unique_violation OR serialization_failure OR deadlock_detected THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','CONFLICT','message','记录或请求编号冲突，请重新读取后重试','status',409));
  WHEN check_violation OR not_null_violation OR foreign_key_violation OR invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN
    RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','VALIDATION','message','业务数据或关联无效','status',400));
END $fn$;

-- SECURITY DEFINER依赖固定search_path和显式服务角色校验。内部助手对service_role也不开放。
REVOKE ALL ON FUNCTION public.huoji_fail(text,text,int), public.huoji_cursor(text,text), public.huoji_function_product(text),
  public.huoji_summary(text,text,date,bool), public.huoji_project(text,text,bool), public.huoji_media_json(text),
  public.huoji_procurement_json(text), public.huoji_check_document(text,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.huoji_command(text,text,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.huoji_command(text,text,text,jsonb) TO service_role;
COMMIT;
