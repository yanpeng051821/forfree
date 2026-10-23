BEGIN;
SELECT pg_advisory_xact_lock(hashtext('huoji-merchant-scope-20261018'));
-- Extend the existing authenticated core in place, preserving receipts and trash handling.
DO $repair$
DECLARE definition text; original text;
BEGIN
  definition:=pg_get_functiondef('public.huoji_command_core_20261018(text,text,text,jsonb)'::regprocedure);
  IF position(':supplier:' in definition)>0 THEN RETURN; END IF;
  original:=definition;
  definition:=replace(definition, 'favorite_value := COALESCE((p_payload->>''favorite'')::bool,false); limit_value',
    'IF p_payload ? ''supplier'' AND (jsonb_typeof(p_payload->''supplier'') IS DISTINCT FROM ''string'' OR length(p_payload->>''supplier'')>200) THEN PERFORM public.huoji_fail(''VALIDATION'',''商家筛选无效''); END IF; favorite_value := COALESCE((p_payload->>''favorite'')::bool,false); limit_value');
  definition:=replace(definition, 'CASE WHEN favorite_value THEN '':favorites'' ELSE '''' END;',
    'CASE WHEN favorite_value THEN '':favorites'' ELSE '''' END || CASE WHEN p_payload ? ''supplier'' THEN '':supplier:'' || (p_payload->>''supplier'') ELSE '''' END;');
  definition:=replace(definition, 'AND (NOT favorite_value OR p.fields->''favorite'' = ''true''::jsonb)',
    'AND (NOT favorite_value OR p.fields->''favorite'' = ''true''::jsonb) AND (NOT (p_payload ? ''supplier'') OR COALESCE(p.fields->>''supplier'','''') = p_payload->>''supplier'')');
  definition:=replace(definition, '''summary'',public.huoji_summary(p_owner,project_id,day_value,favorite_value)',
    '''summary'',(SELECT jsonb_build_object(''total'',count(*),''confirmed'',count(*) FILTER(WHERE p.fields->''confirmed''=''true''::jsonb),''pending'',count(*) FILTER(WHERE p.fields->''confirmed'' IS DISTINCT FROM ''true''::jsonb),''missingPrice'',count(*) FILTER(WHERE p.fields->>''unitPrice'' IS NULL),''suppliers'',count(DISTINCT nullif(p.fields->>''supplier'','''')),''photos'',COALESCE(sum(jsonb_array_length(public.huoji_function_product(p.id)->''photos'')),0)) FROM public.huoji_products p WHERE p.owner_id=p_owner AND p.deleted_at IS NULL AND (project_id IS NULL OR p.project_id=command.project_id) AND (day_value IS NULL OR (p.created_at >= (day_value::timestamp AT TIME ZONE ''Asia/Shanghai'') AND p.created_at < ((day_value+1)::timestamp AT TIME ZONE ''Asia/Shanghai''))) AND (NOT favorite_value OR p.fields->''favorite''=''true''::jsonb) AND (NOT(p_payload ? ''supplier'') OR COALESCE(p.fields->>''supplier'','''')=p_payload->>''supplier''))');
  IF definition=original OR position(':supplier:' in definition)=0 OR position('商家筛选无效' in definition)=0 THEN RAISE EXCEPTION 'Unrecognized merchant filter implementation'; END IF;
  EXECUTE definition;
END $repair$;
-- Aggregate merchant summaries directly; no product/photo hydration for the navigation rail.
DO $merchants$
DECLARE definition text;
BEGIN
  definition:=pg_get_functiondef('public.huoji_command_core_20261018(text,text,text,jsonb)'::regprocedure);
  IF position('WHEN ''merchant/list'' THEN' in definition)>0 THEN RETURN; END IF;
  definition:=replace(definition, 'WHEN ''product/get'' THEN', $branch$
    WHEN 'merchant/list' THEN
      project_id:=nullif(p_payload->>'projectId',''); day_value:=(p_payload->>'date')::date; favorite_value:=COALESCE((p_payload->>'favorite')::bool,false);
      IF project_id IS NULL AND day_value IS NULL AND NOT favorite_value THEN PERFORM public.huoji_fail('INVALID_SCOPE','请选择任务、日期或收藏'); END IF;
      IF project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.huoji_projects p WHERE p.owner_id=p_owner AND p.id=project_id) THEN PERFORM public.huoji_fail('NOT_FOUND','任务不存在或无权访问',404); END IF;
      SELECT COALESCE(jsonb_agg(g.info ORDER BY g.latest DESC,g.supplier),'[]'::jsonb) INTO result FROM (
        SELECT COALESCE(p.fields->>'supplier','') supplier, MAX(p.created_at) latest,
          jsonb_build_object('supplier',COALESCE(p.fields->>'supplier',''),'supplierContact',COALESCE((array_agg(p.fields->>'supplierContact' ORDER BY p.created_at DESC,p.id DESC) FILTER(WHERE COALESCE(p.fields->>'supplierContact','')<>''))[1],''),
            'total',count(*),'confirmed',count(*) FILTER(WHERE p.fields->'confirmed'='true'::jsonb),
            'pending',count(*) FILTER(WHERE p.fields->'confirmed' IS DISTINCT FROM 'true'::jsonb),'missingPrice',count(*) FILTER(WHERE p.fields->>'unitPrice' IS NULL)) info
        FROM public.huoji_products p WHERE p.owner_id=p_owner AND p.deleted_at IS NULL AND (project_id IS NULL OR p.project_id=command.project_id)
          AND (day_value IS NULL OR (p.created_at >= (day_value::timestamp AT TIME ZONE 'Asia/Shanghai') AND p.created_at < ((day_value+1)::timestamp AT TIME ZONE 'Asia/Shanghai')))
          AND (NOT favorite_value OR p.fields->'favorite'='true'::jsonb) GROUP BY COALESCE(p.fields->>'supplier','')
      ) g;
    WHEN 'product/get' THEN
$branch$);
  IF position('WHEN ''merchant/list'' THEN' in definition)=0 THEN RAISE EXCEPTION 'Unrecognized merchant aggregation'; END IF;
  EXECUTE definition;
END $merchants$;

-- Export-job receipts allow the same exact merchant selector.
DO $jobs$
DECLARE definition text;
BEGIN
  definition:=pg_get_functiondef('public.huoji_command(text,text,text,jsonb)'::regprocedure);
  IF position('商家导出筛选无效' in definition)>0 THEN RETURN; END IF;
  IF position('ARRAY[''projectId'',''date'',''scope'',''images'',''favorite'',''audience'']' in definition)=0 THEN RAISE EXCEPTION 'Unrecognized export jobs'; END IF;
  definition:=replace(definition, 'ARRAY[''projectId'',''date'',''scope'',''images'',''favorite'',''audience'']', 'ARRAY[''projectId'',''date'',''scope'',''images'',''favorite'',''audience'',''supplier'']');
  definition:=replace(definition, 'IF input_value ? ''projectId'' THEN', 'IF input_value ? ''supplier'' AND (jsonb_typeof(input_value->''supplier'') IS DISTINCT FROM ''string'' OR length(input_value->>''supplier'')>200) THEN PERFORM public.huoji_fail(''VALIDATION'',''商家导出筛选无效''); END IF; IF input_value ? ''projectId'' THEN');
  EXECUTE definition;
END $jobs$;
COMMIT;
