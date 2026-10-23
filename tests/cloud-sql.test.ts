import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 仅检查迁移源码不变量，不冒充远端PG执行、RLS或并发验收。
const sql = readFileSync(join(__dirname, '..', 'cloudbase', 'migrations', '20261017030424_huoji_core.sql'), 'utf8');
const command = sql.slice(sql.indexOf('CREATE FUNCTION public.huoji_command('), sql.indexOf('END $fn$;', sql.indexOf('CREATE FUNCTION public.huoji_command(')));
function branch(operation: string): string {
  const start = command.indexOf(`WHEN '${operation}' THEN`);
  assert.ok(start >= 0, `缺少分支：${operation}`);
  const end = command.indexOf('\n    WHEN ', start + 1);
  return command.slice(start, end < 0 ? undefined : end);
}

const tables = ['huoji_users', 'huoji_sessions', 'huoji_projects', 'huoji_products', 'huoji_media', 'huoji_receipts', 'huoji_procurement', 'huoji_templates'];

test('原版本迁移仅新增8张货记表，不操作健康或Storage对象', () => {
  assert.deepEqual([...sql.matchAll(/CREATE TABLE public\.(\w+)\s*\(/g)].map(match => match[1]), tables);
  assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE)\b|\bstorage\s*\./i);
  assert.match(sql, /\bBEGIN;[\s\S]*\bCOMMIT;\s*$/);
  assert.deepEqual([...sql.matchAll(/CREATE (?:TABLE|(?:UNIQUE )?INDEX|FUNCTION) (?:public\.)?(\w+)/g)].map(match => match[1]).filter(name => !name.startsWith('huoji_')), []);
});

test('8张表全部启用RLS并撤销客户端及服务角色直接访问', () => {
  const loop = sql.match(/FOREACH t IN ARRAY ARRAY\[([^\]]+)\] LOOP([\s\S]*?)END LOOP;/);
  assert.ok(loop);
  assert.deepEqual([...loop[1].matchAll(/'([^']+)'/g)].map(match => match[1]), tables);
  assert.match(loop[2], /ALTER TABLE public\.%I ENABLE ROW LEVEL SECURITY/);
  assert.match(loop[2], /REVOKE ALL ON TABLE public\.%I FROM PUBLIC, anon, authenticated, service_role/);
  assert.doesNotMatch(sql, /GRANT\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE)\b/i);
});

test('固定search_path且唯一SECURITY DEFINER入口保留auth.role守卫', () => {
  const declarations = [...sql.matchAll(/CREATE FUNCTION public\.\w+\([\s\S]*?AS \$fn\$/g)];
  assert.equal(declarations.length, 9);
  for (const declaration of declarations) assert.match(declaration[0], /SET search_path = pg_catalog/);
  assert.equal(declarations.filter(declaration => /\bSECURITY DEFINER\b/.test(declaration[0])).length, 1);
  assert.match(command, /LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog/);
  assert.ok(command.indexOf("IF auth.role() IS DISTINCT FROM 'service_role'") < command.indexOf("IF p_operation = 'health'"));
  assert.doesNotMatch(sql, /\bset_config\s*\(|\bSET\s+(?:LOCAL\s+)?(?:ROLE|request\.)/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.huoji_command\(text,text,text,jsonb\) FROM PUBLIC, anon, authenticated;/);
  assert.deepEqual([...sql.matchAll(/GRANT EXECUTE ON FUNCTION ([^;]+);/g)].map(match => match[1]), ['public.huoji_command(text,text,text,jsonb) TO service_role']);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.huoji_fail[\s\S]*?huoji_check_document\(text,jsonb\) FROM PUBLIC, anon, authenticated, service_role;/);
});

test('局部变量限定名必须引用显式声明的PLpgSQL块标签', () => {
  assert.match(command, /#variable_conflict use_variable\s+<<command>>\s+DECLARE/);
  assert.doesNotMatch(command, /\bhuoji_command\.(?:id|fields|request_key|project_id)\b/);
  assert.deepEqual([...new Set([...command.matchAll(/\bcommand\.(\w+)/g)].map(match => match[1]))].sort(), ['fields', 'id', 'project_id', 'request_key']);
  assert.match(branch('product/save'), /SET fields = command\.fields[\s\S]*huoji_products\.id = command\.id/);
  assert.match(command, /huoji_receipts\.request_key = command\.request_key/);
});

test('用户行锁先于会话校验、回执和业务变更，异常回滚在同一函数块', () => {
  const lock = command.indexOf('WHERE huoji_users.id = p_owner FOR UPDATE;');
  const session = command.indexOf('WHERE owner_id = p_owner AND token_hash = p_token_hash');
  const replay = command.indexOf('SELECT * INTO receipt');
  const change = command.indexOf('CASE p_operation');
  const receiptWrite = command.indexOf('INSERT INTO public.huoji_receipts');
  assert.ok(lock >= 0 && lock < session && session < replay && replay < change && change < receiptWrite);
  assert.match(command, /digest_value := encode\(sha256\(convert_to\(p_operation[\s\S]*p_payload - 'digest' - 'checkOnly'/);
  assert.match(command, /IF receipt\.digest <> digest_value THEN PERFORM public\.huoji_fail\('CONFLICT'/);
  assert.match(command, /EXCEPTION\s+WHEN SQLSTATE 'P0001'[\s\S]*unique_violation OR serialization_failure OR deadlock_detected/);
});

test('MEDIA位置唯一约束在重排前解除引用，CAS先于媒体变更', () => {
  assert.match(sql, /CREATE UNIQUE INDEX huoji_media_position ON public\.huoji_media\(product_id, position\) WHERE product_id IS NOT NULL;/);
  const save = branch('product/save');
  const cas = save.indexOf('pr.version <> version_value');
  const detach = save.indexOf('UPDATE public.huoji_media SET product_id = NULL');
  const attach = save.indexOf('UPDATE public.huoji_media photo_row SET product_id = command.id, position = (photo.ordinality - 1)::int');
  assert.ok(cas >= 0 && cas < detach && detach < attach);
  assert.match(save, /m\.product_id IS NOT NULL AND m\.product_id IS DISTINCT FROM id/);
  assert.match(save, /count\(DISTINCT value\)/);
  assert.match(save, /GET DIAGNOSTICS affected = ROW_COUNT;\s+IF affected <> 1 THEN/);
  assert.match(branch('media/retire'), /IF m\.product_id IS NOT NULL THEN PERFORM public\.huoji_fail\('CONFLICT'/);
});

test('采购来源按owner去重且更新禁止改变来源和标识并执行CAS', () => {
  assert.match(sql, /CREATE UNIQUE INDEX huoji_procurement_source ON public\.huoji_procurement\(owner_id, source_hash\) WHERE source_hash IS NOT NULL;/);
  assert.match(branch('procurement/create'), /WHERE owner_id = p_owner AND source_hash = source_value;\s+IF FOUND THEN RETURN/);
  const update = branch('procurement/update');
  assert.match(update, /doc->>'id' IS DISTINCT FROM id OR doc->>'sourceHash' IS DISTINCT FROM pc\.document->>'sourceHash' OR doc->>'createdAt' IS DISTINCT FROM pc\.document->>'createdAt'/);
  assert.match(update, /IF pc\.version IS DISTINCT FROM version_value THEN PERFORM public\.huoji_fail\('CONFLICT'/);
  assert.match(update, /WHERE owner_id = p_owner AND huoji_procurement\.id = command\.id AND version = version_value;/);
  assert.match(command, /doc - 'version' - 'updatedAt'/);
});

test('产品、媒体、采购读取均校验owner，profile/template/favorite保留版本检查', () => {
  for (const operation of ['product/get', 'media/get', 'procurement/get']) {
    assert.match(branch(operation), /WHERE [\s\S]*owner_id = p_owner/);
    assert.match(branch(operation), /huoji_fail\('NOT_FOUND'/);
  }
  assert.match(branch('saveProfile'), /u\.profile_version <> version_value/);
  assert.match(branch('template/save'), /COALESCE\(tpl\.version,0\) <> version_value/);
  assert.match(branch('product/favorite'), /pr\.version <> version_value[\s\S]*AND version = version_value;/);
});
