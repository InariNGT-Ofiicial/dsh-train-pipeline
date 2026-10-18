/**
 * 契约自检：不连 DSH，用假的 ctx/tools 把插件 load 一遍。
 *
 * 检查的是「加载期会不会炸」和「工具定义是否符合 Cordis 契约」，
 * 不检查业务正确性（那要真素材）。
 */
import assert from 'node:assert';

const registered = [];
const logs = [];

const ctx = {
  logger: {
    info: (m) => logs.push(['info', m]),
    warn: (m) => logs.push(['warn', m]),
    error: (m) => logs.push(['error', m]),
  },
  get: (key) => (key === 'tools' ? { register: (def) => registered.push(def) } : undefined),
};

const mod = await import('../src/index.js');

assert.equal(mod.name, 'train-pipeline', '插件 id 应为 train-pipeline');
assert.deepEqual(mod.inject, ['tools'], 'inject 应为 ["tools"]');
assert.equal(typeof mod.apply, 'function', 'apply 必须导出');

await mod.apply(ctx, {});

assert.ok(registered.length >= 18, `应注册 ≥18 个工具，实际 ${registered.length}`);

const need = [
  'train_sources', 'train_doctor', 'train_setup', 'train_plan',
  // 素材获取
  'train_hunt', 'train_toolchain', 'train_fetch', 'train_unpack', 'train_acquire',
  // 数据集与训练
  'train_scan',
  'train_build', 'train_qc', 'train_preprocess', 'train_run', 'train_status',
  'train_stop', 'train_infer', 'train_register', 'train_overview',
];
const names = registered.map((t) => t.name);
for (const n of need) assert.ok(names.includes(n), `缺少工具: ${n}`);
assert.equal(new Set(names).size, names.length, '工具名不能重复');

for (const t of registered) {
  assert.ok(t.description && t.description.length > 20, `${t.name}: description 太短`);
  assert.equal(t.parameters?.type, 'object', `${t.name}: parameters 必须是 object schema`);
  assert.ok(t.output?.schema, `${t.name}: output 必须是 { schema, render }`);
  assert.equal(typeof t.output.render, 'function', `${t.name}: output.render 必须是函数`);
  assert.equal(typeof t.execute, 'function', `${t.name}: execute 必须是函数`);
  const rendered = t.output.render({}, { ok: true, rendered: 'x' });
  assert.ok(Array.isArray(rendered) && rendered[0].type === 'text', `${t.name}: render 必须返回 text part`);
}

console.log(`✅ 契约自检通过：${registered.length} 个工具`);
console.log('   ' + names.join(', '));

const warns = logs.filter(([lv]) => lv === 'warn');
if (warns.length) console.log(`   （加载期 ${warns.length} 条 warn，不阻塞）`);
