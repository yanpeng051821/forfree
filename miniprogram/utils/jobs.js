const api = require('./api');
const session = require('./session');

// 轮询窗口：服务端模型超时30秒，回写后客户端还要再取一次，
// 40 次为模型调用、数据库回写和网络延迟留出空间，单次仍受容器通道超时限制。
const POLL_INTERVAL_MS = 1500;
const MAX_POLLS = 40;

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

/**
 * 轮询持久任务直到成功或失败。
 * 成功返回任务视图（整理任务的 result 就是抽取出的字段）；
 * 失败抛出服务端错误码与文案，超时抛 JOB_TIMEOUT；调用方负责把文案呈现给用户。
 */
async function pollJob(jobId, binding, options) {
  const interval = options && options.interval !== undefined ? options.interval : POLL_INTERVAL_MS;
  const limit = options && options.maxPolls !== undefined ? options.maxPolls : MAX_POLLS;
  for (let attempt = 0; attempt < limit; attempt += 1) {
    session.assert(binding);
    if (options && options.isCurrent && !options.isCurrent()) throw session.error('IDENTITY_CHANGED', '页面已变化');
    const view = await api.getJob(jobId, binding);
    session.assert(binding);
    if (options && options.isCurrent && !options.isCurrent()) throw session.error('IDENTITY_CHANGED', '页面已变化');
    if (!view || view.jobId !== jobId || !['pending', 'running', 'succeeded', 'failed'].includes(view.state)) throw session.error('BAD_RESPONSE', '任务回执无效，请重试');
    if (view.state === 'succeeded') return view;
    if (view && view.state === 'failed') {
      const error = session.error((view.error && view.error.code) || 'JOB_FAILED', (view.error && view.error.message) || '整理失败，请稍后重试');
      error.jobFailure = { jobId: view.jobId, kind: view.kind, state: view.state }; throw error;
    }
    if (attempt < limit - 1) await wait(interval);
  }
  throw session.error('JOB_TIMEOUT', '整理仍在进行，请稍后重试');
}

/**
 * 提交 AI 整理并轮询到结果：返回 { jobId, result }，result 为抽取出的字段。
 * 描述与照片号只在提交时发送一次，之后只用任务号轮询。
 */
async function extractOnce(description, photoIds, binding, options) {
  const submitted = await api.extractAsync(description, photoIds, binding);
  if (submitted && submitted.fields) return { jobId: null, result: submitted };
  const jobId = submitted && submitted.jobId;
  if (!jobId) throw session.error('BAD_RESPONSE', '整理任务未创建，请稍后重试');
  const view = await pollJob(jobId, binding, options);
  if (view.kind !== 'extraction' || !view.result || !view.result.fields) throw session.error('BAD_RESPONSE', '整理结果无效，请重试');
  return { jobId, result: view.result };
}
async function runExtract(description, photoIds, binding, options) {
  try { return await extractOnce(description, photoIds, binding, options); }
  catch (error) {
    const extractionFailure = error.jobFailure && error.jobFailure.kind === 'extraction' && error.jobFailure.state === 'failed';
    const needsRecovery = extractionFailure && (error.code === 'MODEL_LOGIN_REQUIRED' || (error.code === 'LOGIN_REQUIRED' && /共享模型|共享服务|模型服务/.test(error.message || '')));
    if (!needsRecovery) throw error;
    session.assert(binding);
    if (options && options.isCurrent && !options.isCurrent()) throw session.error('IDENTITY_CHANGED', '页面已变化');
    await api.restoreModelSession(binding);
    session.assert(binding);
    if (options && options.isCurrent && !options.isCurrent()) throw session.error('IDENTITY_CHANGED', '页面已变化');
    return extractOnce(description, photoIds, binding, options);
  }
}

module.exports = { pollJob, runExtract, POLL_INTERVAL_MS, MAX_POLLS };
