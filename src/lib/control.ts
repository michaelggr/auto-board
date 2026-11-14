import type { DB } from '@/lib/db';
import { getConfig } from '@/lib/config';
import { getGeekSession } from '@/collector/geek/session';

export interface PairInfo { source: string; key: string; name: string; enabled: number | null; }
export type ToggleOutcome =
  | { status: 200; actionId: number }
  | { status: 409; pair: PairInfo }                     // 成对护栏：前端二次确认后重发
  | { status: 502; error: string };

export interface ToggleOpts {
  confirmPair?: boolean;
  /** 测试注入：极客版会话替身；缺省用全局单例 */
  session?: { call(method: string, params?: Record<string, unknown>): Promise<unknown> };
  /** 测试注入：HA fetch 替身；缺省用全局 fetch */
  fetchImpl?: typeof fetch;
}

/** 查与 (source,key) 配对的对侧规则（rule_pairs 双向查；对侧已删除返回 null） */
function findPair(db: DB, source: 'ha' | 'geek', key: string): PairInfo | null {
  const mineCol = source === 'ha' ? 'ha_key' : 'geek_key';
  const otherCol = source === 'ha' ? 'geek_key' : 'ha_key';
  const otherSource = source === 'ha' ? 'geek' : 'ha';
  const row = db.prepare(`
    SELECT p.${otherCol} AS k, a.name AS n, a.enabled AS e
    FROM rule_pairs p
    JOIN automations a ON a.source = ? AND a.key = p.${otherCol}
    WHERE p.${mineCol} = ? AND a.deleted_at IS NULL
  `).get(otherSource, key) as { k: string; n: string; e: number | null } | undefined;
  return row ? { source: otherSource, key: row.k, name: row.n, enabled: row.e } : null;
}

/** 启停一条自动化（唯一写远端出口）。审计先行：成功/失败都留痕，撤回依据 prev_state。 */
export async function toggleAutomation(
  db: DB, source: 'ha' | 'geek', key: string, enable: boolean, opts: ToggleOpts = {},
): Promise<ToggleOutcome> {
  const auto = db.prepare(`SELECT name, enabled FROM automations WHERE source=? AND key=?`)
    .get(source, key) as { name: string; enabled: number | null } | undefined;
  if (!auto) return { status: 502, error: '规则不存在' };

  // 成对护栏：对侧状态与本次反向 → 409 要求确认（同向操作不拦，见 Step 15.1 用例 3）
  if (!opts.confirmPair) {
    const pair = findPair(db, source, key);
    if (pair && pair.enabled !== null && (pair.enabled === 1) !== enable) {
      return { status: 409, pair };
    }
  }

  const result = await execToggle(source, key, enable, opts);
  const prev = auto.enabled;
  const ins = db.prepare(`INSERT INTO actions (source, key, action, prev_state, result, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  if (!result.ok) {
    ins.run(source, key, enable ? 'enable' : 'disable', prev, 'fail', Date.now());
    return { status: 502, error: result.error! };
  }
  db.prepare(`UPDATE automations SET enabled=? WHERE source=? AND key=?`).run(enable ? 1 : 0, source, key);
  const r = ins.run(source, key, enable ? 'enable' : 'disable', prev, 'success', Date.now());
  return { status: 200, actionId: Number(r.lastInsertRowid) };
}

/** 执行层：geek=changeGraphConfig / HA=REST services（设计 §3.2：仅禁触发器，不打断执行中 run） */
async function execToggle(
  source: 'ha' | 'geek', key: string, enable: boolean, opts: ToggleOpts,
): Promise<{ ok: boolean; error?: string }> {
  if (source === 'geek') {
    const session = opts.session ?? getGeekSession();
    try {
      await session.call('changeGraphConfig', { id: key, enable });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }
  const { haUrl, haToken } = getConfig();
  if (!haUrl || !haToken) return { ok: false, error: '未配置 HA_URL/HA_TOKEN' };
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${haUrl}/api/services/automation/${enable ? 'turn_on' : 'turn_off'}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${haToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_id: key }),
    });
    return res.ok ? { ok: true } : { ok: false, error: `HA HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** 撤回某次启停：反向执行 + 原审计行标 undone=1。undo 本身也是一次操作（产生新审计行）。 */
export async function undoAction(
  db: DB, actionId: number, opts: ToggleOpts = {},
): Promise<{ status: number; error?: string }> {
  const act = db.prepare(`SELECT * FROM actions WHERE id=? AND undone=0`).get(actionId) as
    | { source: 'ha' | 'geek'; key: string; action: 'enable' | 'disable' }
    | undefined;
  if (!act) return { status: 404, error: '操作不存在或已撤回' };
  const reverse = act.action !== 'enable';                 // enable 的反向是 disable
  const r = await toggleAutomation(db, act.source, act.key, reverse, { ...opts, confirmPair: true });
  if (r.status !== 200) {
    return { status: r.status, error: r.status === 502 ? (r as { error: string }).error : '撤回执行失败' };
  }
  db.prepare(`UPDATE actions SET undone=1 WHERE id=?`).run(actionId);
  return { status: 200 };
}
