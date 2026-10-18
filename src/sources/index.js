/**
 * 素材源适配器统一契约。
 *
 * 为什么要抽象这一层：
 *   「galgame 解包」和「番剧/录屏」在**识别角色**这件事上根本不是一类问题，
 *   但它们在「产出 dataset_raw/<角色>/*.wav」之后就完全同流了。
 *   所以契约只切在两处：detect（能不能接）与 build（怎么出料），中间不强行统一。
 *
 * 每个 adapter 必须声明 capabilities.implemented[]，**没实现的必须是空数组**，
 * 而不是给个假实现假装能跑 —— 这是本插件对用户的基本诚实。
 */
import galgame from './galgame.js';
import media from './media.js';

export const ADAPTERS = { galgame, media };

export function getAdapter(id) {
  const key = String(id ?? '').trim().toLowerCase();
  return ADAPTERS[key] ?? null;
}

export function listAdapters() {
  return Object.values(ADAPTERS).map((a) => ({
    id: a.id,
    name: a.name,
    flagship: !!a.flagship,
    implemented: a.capabilities.implemented,
    pending: a.capabilities.pending ?? [],
    why: a.why ?? '',
    need: a.need ?? '',
  }));
}

/** 自动判断该用哪个适配器：能 detect 通过的第一个（旗舰优先） */
export async function detectAdapter(ctx, input) {
  const ordered = Object.values(ADAPTERS).sort((a, b) => (b.flagship ? 1 : 0) - (a.flagship ? 1 : 0));
  const tried = [];
  for (const a of ordered) {
    if (!a.capabilities.implemented.includes('detect')) continue;
    try {
      const r = await a.detect(ctx, { input });
      tried.push({ id: a.id, ok: !!r.ok, detail: r.detail ?? '' });
      if (r.ok) return { adapter: a, result: r, tried };
    } catch (e) {
      tried.push({ id: a.id, ok: false, detail: String(e?.message ?? e) });
    }
  }
  return { adapter: null, result: null, tried };
}
