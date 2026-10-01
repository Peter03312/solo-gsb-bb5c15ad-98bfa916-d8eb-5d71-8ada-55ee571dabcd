'use strict';

const express = require('express');
const { query, withExhibitTransaction } = require('../db');
const { requireRole, requireAuth } = require('../auth');
const { recordAudit } = require('../audit');
const {
  ValidationError,
  assertDate,
  parseTimeToMinutes,
  nonEmptyString,
} = require('../validation');
const {
  lockExhibit,
  getPlan,
  getActiveMeasurements,
  getBlackouts,
  planRemainingAfterConfirmed,
  validateBlackoutWindow,
} = require('../service');
const {
  doseByYear,
  intersectIntervals,
  tsToWallString,
  yearMapToObject,
} = require('../dosing');

const router = express.Router();

router.use(requireAuth);

function parseBlackoutBody(body) {
  const startDate = assertDate(body.startDate, '停灯开始日期');
  const endDate = body.endDate ? assertDate(body.endDate, '停灯结束日期') : startDate;
  const startMinute = parseTimeToMinutes(body.startTime);
  const endMinute = parseTimeToMinutes(body.endTime);
  if (endDate < startDate) throw new ValidationError('停灯结束日期不能早于开始日期');
  const reason = nonEmptyString(body.reason, '停灯原因', 1000);
  return { startDate, endDate, startMinute, endMinute, reason };
}

function serializeBlackout(row) {
  return {
    id: row.id,
    planId: row.plan_id,
    exhibitId: row.exhibit_id,
    planTitle: row.plan_title || null,
    start: tsToWallString(new Date(row.start_ts).getTime()),
    end: tsToWallString(new Date(row.end_ts).getTime()),
    reason: row.reason,
    createdBy: row.created_by,
    creatorName: row.creator_name || null,
    createdAt: row.created_at,
    yearly: row.yearly || {},
    activePlan: row.activePlan || false,
    immutable: true,
  };
}

/** 停灯记录列表：可按展品/计划过滤；布展员只读。 */
router.get('/', async (req, res, next) => {
  try {
    const exhibitId = req.query.exhibitId ? Number(req.query.exhibitId) : null;
    const planId = req.query.planId ? Number(req.query.planId) : null;
    const { rows } = await query(
      `SELECT * FROM light_blackouts
        WHERE ($1::bigint IS NULL OR exhibit_id = $1)
          AND ($2::bigint IS NULL OR plan_id = $2)
        ORDER BY start_ts DESC, id DESC`,
      [Number.isInteger(exhibitId) ? exhibitId : null, Number.isInteger(planId) ? planId : null]
    );
    if (rows.length === 0) return res.json({ blackouts: [] });
    const planIds = [...new Set(rows.map((b) => Number(b.plan_id)))];
    const exhibitIds = [...new Set(rows.map((b) => Number(b.exhibit_id)))];
    const userIds = [...new Set(rows.map((b) => Number(b.created_by)).filter(Boolean))];
    const ph = (list) => list.map((_, i) => `$${i + 1}`).join(',');
    const { rows: planRows } = await query(
      `SELECT * FROM plans WHERE id IN (${ph(planIds)})`,
      planIds
    );
    const planMap = new Map(planRows.map((p) => [Number(p.id), p]));
    const confirmedByExhibit = new Map();
    for (const exhibitId of exhibitIds) {
      const { rows: confirmedRows } = await query(
        `SELECT plan_id, start_ts, end_ts
           FROM measurements
          WHERE exhibit_id = $1 AND status = 'confirmed'`,
        [exhibitId]
      );
      confirmedByExhibit.set(exhibitId, confirmedRows.map((m) => ({
        planId: Number(m.plan_id),
        start: new Date(m.start_ts).getTime(),
        end: new Date(m.end_ts).getTime(),
      })));
    }
    let userMap = new Map();
    if (userIds.length > 0) {
      const { rows: userRows } = await query(
        `SELECT id, display_name FROM users WHERE id IN (${ph(userIds)})`,
        userIds
      );
      userMap = new Map(userRows.map((u) => [Number(u.id), u.display_name]));
    }
    const enriched = rows.map((b) => {
      const plan = planMap.get(Number(b.plan_id));
      const remaining = plan && ['approved', 'pending_review'].includes(plan.status)
        ? planRemainingAfterConfirmed(
            plan,
            (confirmedByExhibit.get(Number(b.exhibit_id)) || [])
          )
        : [];
      const effective = intersectIntervals(
        [{ start: new Date(b.start_ts).getTime(), end: new Date(b.end_ts).getTime() }],
        remaining
      );
      return {
        ...b,
        plan_title: plan ? plan.title : null,
        creator_name: userMap.get(Number(b.created_by)) || null,
        activePlan: !!plan && ['approved', 'pending_review'].includes(plan.status),
        yearly: plan
          ? yearMapToObject(doseByYear(effective, Number(plan.estimated_lux)))
          : {},
      };
    });
    res.json({ blackouts: enriched.map(serializeBlackout) });
  } catch (err) {
    next(err);
  }
});

/**
 * 保管员登记已发生停灯。
 * 完整校验在展品锁事务内进行；任何窗口/重叠冲突均不写入。
 */
router.post('/', requireRole('conservator'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const planId = Number(body.planId);
    if (!Number.isInteger(planId)) throw new ValidationError('计划 ID 无效');
    const input = parseBlackoutBody(body);

    const prePlan = await getPlan({ query }, planId);
    const result = await withExhibitTransaction(prePlan.exhibit_id, async (client) => {
      await lockExhibit(client, prePlan.exhibit_id);
      const plan = await getPlan(client, planId);
      const { start, end } = await validateBlackoutWindow(
        client,
        plan,
        input.startDate,
        input.startMinute,
        input.endDate,
        input.endMinute
      );

      const inserted = await client.query(
        `INSERT INTO light_blackouts
           (plan_id, exhibit_id, start_ts, end_ts, reason, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [planId, plan.exhibit_id, new Date(start), new Date(end), input.reason,
          req.sessionUser.userId]
      );

      // 登记时计算本次从“未被已确认实测覆盖的估算时段”中实际扣减的按年剂量。
      const confirmed = await getActiveMeasurements(client, plan.exhibit_id);
      const confirmedWindows = confirmed.map((m) => ({
        start: new Date(m.start_ts).getTime(),
        end: new Date(m.end_ts).getTime(),
      }));
      const estimatedRemaining = planRemainingAfterConfirmed(plan, confirmedWindows);
      const effective = intersectIntervals([{ start, end }], estimatedRemaining);
      const yearly = yearMapToObject(doseByYear(effective, Number(plan.estimated_lux)));

      await recordAudit(client, req.sessionUser, 'blackout.create', 'light_blackout',
        inserted.rows[0].id, {
          planId,
          exhibitId: plan.exhibit_id,
          start: tsToWallString(start),
          end: tsToWallString(end),
          reason: input.reason,
          yearlyDeduction: yearly,
        });

      const row = {
        ...inserted.rows[0],
        plan_title: plan.title,
        creator_name: req.sessionUser.displayName,
        yearly,
      };
      return { blackout: serializeBlackout(row) };
    });

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = { router, serializeBlackout, getBlackoutList: getBlackouts };
