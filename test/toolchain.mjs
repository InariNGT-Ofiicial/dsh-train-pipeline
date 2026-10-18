/**
 * 工具链「安装」路径自检（可离线复用缓存）。
 *
 * 只测 GARbro：它的 zip 已经到了本地缓存，重装不会重新下载；
 * 而且它是「装上但只能人工用」的典型 —— 正好验证 installed 与 usable 的区分。
 */
import assert from 'node:assert';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..');
const ws = join(root, '_tmp', 'ws-tool');
mkdirSync(ws, { recursive: true });

const registered = new Map();
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  get: (k) => (k === 'tools' ? { register: (d) => registered.set(d.name, d) } : undefined),
};
const mod = await import('../src/index.js');
await mod.apply(ctx, { trainRoot: ws });
const call = async (name, args = {}) => registered.get(name).execute(args, {});

const before = await call('train_toolchain', { action: 'check' });
assert.ok(before.root, 'check 必须返回 tools 根目录（agent 需要知道装到哪）');
const garbroBefore = before.tools.find((t) => t.id === 'garbro');
const manExists = existsSync(join(before.root, 'manifest.json'));

// 两种情况下都要真的走一遍安装：没装，或装了但没有 manifest（手工拷进去的）
if (!garbroBefore.installed || !manExists) {
  const inst = await call('train_toolchain', { action: 'install', id: 'garbro', force: true });
  assert.ok(inst.ok, `安装失败:\n${inst.rendered}`);
} else {
  console.log(`ℹ️ GARbro 已在位且有 manifest，跳过下载（${garbroBefore.bin}）`);
}

const now = (await call('train_toolchain', { action: 'check' })).tools.find((t) => t.id === 'garbro');
assert.ok(now.installed, '装完应视为 installed');
assert.equal(now.usable, false, 'GUI 类工具不应被算作「插件可自动调用」');
assert.ok(existsSync(now.bin), 'bin 路径必须真实存在');

const manPath = join(before.root, 'manifest.json');
assert.ok(existsSync(manPath), '应写入 manifest.json');
const man = JSON.parse(readFileSync(manPath, 'utf8'));
assert.ok(man.garbro?.version, 'manifest 应记录版本');
assert.ok(man.garbro?.assets?.[0]?.sha256, 'manifest 应记录摘要');
console.log(`✅ toolchain: ${now.name} ${now.version} → ${now.bin}`);
console.log(`   usable=${now.usable}（GUI 类不冒充可自动调用）· manifest 已记 sha256`);

const after = await call('train_toolchain', { action: 'check' });
console.log(`   现状: 可解包=${after.can.unpack} 可反编译=${after.can.decompile}`);
console.log('\n✅ 工具链安装路径自检通过');
