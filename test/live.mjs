/**
 * 真机自检：把我这台机器的实际环境灌进插件，跑只读工具。
 *
 * 与 smoke.mjs 的分工：
 *   smoke  —— 不看环境，只验「契约」，CI 可跑
 *   live   —— 看真环境，验「自动发现 / doctor / 总览」是否真的能用
 *
 * 用法: node test/live.mjs [工具名...]
 * 默认跑 train_sources / train_doctor / train_overview（全部只读）。
 */
const registered = [];
const ctx = {
  logger: { info: () => {}, warn: (m) => console.warn('[warn]', m), error: (m) => console.error('[err]', m) },
  get: (k) => (k === 'tools' ? { register: (d) => registered.push(d) } : undefined),
};

const mod = await import('../src/index.js');
await mod.apply(ctx, {});

const pick = process.argv.slice(2);
const names = pick.length ? pick : ['train_sources', 'train_doctor', 'train_overview'];

for (const n of names) {
  const t = registered.find((x) => x.name === n);
  if (!t) { console.error(`✗ 没有工具 ${n}`); process.exitCode = 1; continue; }
  console.log(`\n${'═'.repeat(72)}\n▶ ${n}\n${'═'.repeat(72)}`);
  const args = n === 'train_scan' ? {} : {};
  const res = await t.execute(args);
  console.log(t.output.render(args, res)[0].text);
  console.log(`\n[ok=${res.ok}]`);
  if (!res.ok) process.exitCode = 1;
}
