BEGIN;
SELECT pg_advisory_xact_lock(hashtext('huoji-product-trash-20261018'));
ALTER TABLE public.huoji_products ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS huoji_products_trash ON public.huoji_products(owner_id,created_at DESC,id DESC) WHERE deleted_at IS NOT NULL;
CREATE OR REPLACE FUNCTION public.huoji_function_product(p_id text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT pr.fields || jsonb_build_object('id', pr.id, 'projectId', pr.project_id, 'version', pr.version,
    'createdAt', pr.created_at, 'updatedAt', pr.updated_at, 'deletedAt',pr.deleted_at,
    'taskName', p.name, 'taskMarket', p.market, 'taskDate', p.date, 'demo', p.demo,
    'photos', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name) ORDER BY m.position)
      FROM public.huoji_media m WHERE m.owner_id = pr.owner_id AND m.product_id = pr.id), '[]'::jsonb))
  FROM public.huoji_products pr JOIN public.huoji_projects p ON p.id = pr.project_id AND p.owner_id = pr.owner_id WHERE pr.id = p_id;
$fn$;
CREATE OR REPLACE FUNCTION public.huoji_summary(p_owner text, p_project text DEFAULT NULL, p_date date DEFAULT NULL, p_favorite bool DEFAULT false)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT jsonb_build_object('total', count(pr.id),
    'confirmed', count(*) FILTER (WHERE pr.fields->'confirmed' = 'true'::jsonb),
    'pending', count(*) FILTER (WHERE pr.fields->'confirmed' IS DISTINCT FROM 'true'::jsonb),
    'missingPrice', count(*) FILTER (WHERE pr.fields->>'unitPrice' IS NULL),
    'suppliers', count(DISTINCT nullif(btrim(pr.fields->>'supplier'), '')),
    'photos', COALESCE(sum((SELECT count(*) FROM public.huoji_media m WHERE m.owner_id = p_owner AND m.product_id = pr.id)),0))
  FROM public.huoji_products pr WHERE pr.owner_id = p_owner AND pr.deleted_at IS NULL
    AND (p_project IS NULL OR pr.project_id = p_project)
    AND (p_date IS NULL OR (pr.created_at >= (p_date::timestamp AT TIME ZONE 'Asia/Shanghai') AND pr.created_at < ((p_date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai')))
    AND (NOT p_favorite OR pr.fields->'favorite' = 'true'::jsonb);
$fn$;

-- Durable AI receipts accept the newly added explicit fields, keeping prior validation.
DO $extraction$
DECLARE definition text;
BEGIN
  definition:=pg_get_functiondef('public.huoji_check_extraction(text)'::regprocedure);
  IF position('exportRemarks' in definition)=0 THEN
    definition:=replace(definition,'''description'',''notes'',''evaluation''','''description'',''notes'',''evaluation'',''barcode'',''exportRemarks''');
    definition:=replace(definition,'k IN (''notes'',''evaluation'')','k IN (''notes'',''evaluation'',''exportRemarks'')');
    definition:=replace(definition,'''leadTimeDays'',''rating''','''leadTimeDays'',''rating'',''cartons'',''quantity''');
    EXECUTE definition;
  END IF;
END $extraction$;

DO $repair$
DECLARE definition text;
BEGIN
  IF to_regprocedure('public.huoji_command_core_20261018(text,text,text,jsonb)') IS NULL THEN RAISE EXCEPTION 'Missing prerequisite core'; END IF;
  definition:=pg_get_functiondef('public.huoji_command_core_20261018(text,text,text,jsonb)'::regprocedure);
  IF position('product/trashPage' in definition)>0 THEN RETURN; END IF;
  IF position('WHEN ''product/get'' THEN' in definition)=0 THEN RAISE EXCEPTION 'Unrecognized product implementation'; END IF;
  definition:=replace(definition,'WHERE p.owner_id = p_owner AND (project_id IS NULL OR p.project_id = command.project_id)',
    'WHERE p.owner_id = p_owner AND p.deleted_at IS NULL AND (project_id IS NULL OR p.project_id = command.project_id)');
  definition:=replace(definition,'FROM public.huoji_products WHERE owner_id = p_owner GROUP BY 1','FROM public.huoji_products WHERE owner_id = p_owner AND deleted_at IS NULL GROUP BY 1');
  definition:=replace(definition,'IF version_value IS NULL OR pr.version <> version_value THEN',
    'IF pr.deleted_at IS NOT NULL THEN PERFORM public.huoji_fail(''PRODUCT_TRASHED'',''商品在回收站，请先恢复'',409); END IF; IF version_value IS NULL OR pr.version <> version_value THEN');
  definition:=replace(definition,'IF jsonb_typeof(p_payload->''favorite'') IS DISTINCT FROM ''boolean'' OR version_value IS NULL THEN',
    'IF pr.deleted_at IS NOT NULL THEN PERFORM public.huoji_fail(''PRODUCT_TRASHED'',''商品在回收站，请先恢复'',409); END IF; IF jsonb_typeof(p_payload->''favorite'') IS DISTINCT FROM ''boolean'' OR version_value IS NULL THEN');
  definition:=replace(definition,'favorite_value bool; check_only bool;', 'has_more bool; favorite_value bool; check_only bool;');
  definition:=replace(definition,'WHEN ''product/get'' THEN',$branches$
    WHEN 'product/trash', 'product/restore' THEN
      IF p_payload - ARRAY['id','version'] <> '{}'::jsonb OR jsonb_typeof(p_payload->'version') IS DISTINCT FROM 'number' OR (p_payload->>'version')::numeric <> trunc((p_payload->>'version')::numeric) OR version_value < 1 THEN PERFORM public.huoji_fail('VALIDATION','商品版本无效'); END IF;
      SELECT * INTO pr FROM public.huoji_products p WHERE p.owner_id = p_owner AND p.id = command.id;
      IF NOT FOUND THEN PERFORM public.huoji_fail('NOT_FOUND','记录不存在或无权访问',404); END IF;
      IF (p_operation='product/trash' AND pr.deleted_at IS NULL) OR (p_operation='product/restore' AND pr.deleted_at IS NOT NULL) THEN
        IF pr.version IS DISTINCT FROM version_value THEN PERFORM public.huoji_fail('CONFLICT','商品已更新，请刷新后重试',409); END IF;
        UPDATE public.huoji_products p SET deleted_at=CASE WHEN p_operation='product/restore' THEN NULL ELSE clock_timestamp() END,
          version=p.version+1,updated_at=clock_timestamp() WHERE p.owner_id=p_owner AND p.id=command.id AND p.version=version_value;
      END IF;
      result:=public.huoji_function_product(command.id);
    WHEN 'product/trashPage' THEN
      limit_value:=COALESCE((p_payload->>'limit')::int,30);query_value:=COALESCE(p_payload->>'q','');cursor_value:=p_payload->>'cursor';scope:='trash';
      IF limit_value NOT BETWEEN 1 AND 100 OR length(query_value)>200 OR p_payload-ARRAY['limit','cursor','q']<>'{}'::jsonb THEN PERFORM public.huoji_fail('VALIDATION','分页或搜索无效'); END IF;
      IF cursor_value IS NOT NULL THEN
        IF cursor_value !~ '^[A-Za-z0-9_-]{43}$' THEN PERFORM public.huoji_fail('INVALID_CURSOR','分页游标无效'); END IF;
        SELECT p.id,p.created_at INTO boundary_id,boundary_time FROM public.huoji_products p WHERE p.owner_id=p_owner AND p.deleted_at IS NOT NULL AND public.huoji_cursor(scope,p.id)=cursor_value;
        IF NOT FOUND THEN PERFORM public.huoji_fail('INVALID_CURSOR','分页游标无效'); END IF;
      END IF;
      escaped_query:='%'||replace(replace(replace(lower(query_value),E'\\',E'\\\\'), '%', E'\\%'), '_', E'\\_')||'%';
      WITH base AS MATERIALIZED (SELECT p.* FROM public.huoji_products p WHERE p.owner_id=p_owner AND p.deleted_at IS NOT NULL
        AND (query_value='' OR lower(COALESCE(p.fields->>'name','')) LIKE escaped_query ESCAPE E'\\' OR lower(COALESCE(p.fields->>'supplier','')) LIKE escaped_query ESCAPE E'\\')),
      page AS (SELECT p.* FROM base p WHERE boundary_id IS NULL OR (p.created_at,p.id)<(boundary_time,boundary_id) ORDER BY p.created_at DESC,p.id DESC LIMIT limit_value+1)
      SELECT (SELECT count(*) FROM base),COALESCE(jsonb_agg(public.huoji_function_product(p.id) ORDER BY p.created_at DESC,p.id DESC) FILTER(WHERE p.position<=limit_value),'[]'::jsonb),count(*)>limit_value
        INTO matched,result,has_more FROM (SELECT page.*,row_number() OVER(ORDER BY created_at DESC,id DESC) position FROM page) p;
      result:=jsonb_build_object('items',result,'matchedCount',matched,'nextCursor',CASE WHEN has_more THEN public.huoji_cursor(scope,result->(limit_value-1)->>'id') ELSE NULL END);
    WHEN 'product/get' THEN
$branches$);
  EXECUTE definition;
END $repair$;
COMMIT;
