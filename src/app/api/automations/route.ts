import { requireAuth } from '@/lib/auth';
import { getDb } from '@/lib/db';

// GET /api/automations?source=ha&room=客厅&status=enabled|disabled|zombie
// status 语义（设计 §6.2）：zombie=启用中且 N 天零触发；停用规则单独归 disabled
export async function GET(req: Request) {
  const denied = requireAuth(req);
  if (denied) return denied;
  const url = new URL(req.url);
  const source = url.searchParams.get('source');
  const room = url.searchParams.get('room');
  const status = url.searchParams.get('status');
  const q = url.searchParams.get('q');                      // 规则名模糊搜索（Task 18 前端用）
  const zombieDays = Number(url.searchParams.get('zombie_days') || 30);
  const db = getDb();
  const rows = db.prepare(`
    SELECT a.source, a.key, a.name, a.room, a.enabled, a.last_triggered AS lastTriggered,
      a.first_seen AS firstSeen,
      CASE WHEN EXISTS (
        SELECT 1 FROM rule_pairs p
        WHERE (a.source='ha' AND p.ha_key=a.key) OR (a.source='geek' AND p.geek_key=a.key)
      ) THEN 1 ELSE 0 END AS paired,
      la.id AS lastActionId, la.action AS lastAction, la.result AS lastActionResult, la.undone AS lastActionUndone, la.created_at AS lastActionAt
    FROM automations a
    LEFT JOIN actions la ON la.id = (
      SELECT id FROM actions WHERE source=a.source AND key=a.key ORDER BY id DESC LIMIT 1
    )
    WHERE a.deleted_at IS NULL
      AND (:source IS NULL OR a.source = :source)
      AND (:room IS NULL OR a.room = :room)
      AND (:q IS NULL OR a.name LIKE '%' || :q || '%')
      AND (:status IS NULL
        OR (:status = 'enabled' AND a.enabled = 1)
        OR (:status = 'disabled' AND a.enabled = 0)
        OR (:status = 'zombie' AND a.enabled = 1 AND COALESCE(a.last_triggered, a.first_seen) < :zombieCut))
    ORDER BY a.source, a.name
  `).all({ source, room, status, q, zombieCut: Date.now() - zombieDays * 86_400_000 });
  return Response.json({ rows });
}
