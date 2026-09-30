import { config } from './config.js';
import { REPORT_REASONS } from './catalog.js';

/**
 * Модерация в памяти процесса: страйки, временные баны чата и IP-баны.
 * Ничего не персится — после перезапуска сервера всё обнуляется, и это осознанно:
 * проект не хранит пользовательские данные.
 */
export class Moderation {
  constructor() {
    /** @type {Map<string, {score:number, until:number|null, reasons:string[], at:number}>} */
    this.strikes = new Map();
    /** @type {Map<string, {sessionId:string, until:number, reason:string, permanent:boolean}>} */
    this.bans = new Map();
    /** @type {Map<string, {count:number, until:number|null}>} */
    this.reportReasons = new Map();
    /** Статистика для /api/stats. */
    this.totals = { reports: 0, bans: 0, mediaBlocks: 0 };
    this.sweep();
  }

  sweep() {
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [key, ban] of this.bans) if (ban.until <= now) this.bans.delete(key);
      for (const [key, rec] of this.strikes) {
        // Страйк «протухает» через сутки без новых жалоб.
        if (rec.until && rec.until <= now) this.strikes.delete(key);
      }
    }, 60_000);
    this.timer.unref?.();
  }

  /**
   * @param {import('./session.js').Session} session
   * @returns {{banned:boolean, until?:number, permanent?:boolean, reason?:string}}
   */
  banStatus(session) {
    const bySession = this.bans.get(session.id);
    if (bySession) {
      if (bySession.until > Date.now()) {
        return { banned: true, until: bySession.until, permanent: bySession.permanent, reason: bySession.reason };
      }
      this.bans.delete(session.id);
    }
    if (session.ip && this.bans.has(session.ip)) {
      const ban = this.bans.get(session.ip);
      if (ban.until > Date.now()) {
        return { banned: true, until: ban.until, permanent: ban.permanent, reason: ban.reason };
      }
      this.bans.delete(session.ip);
    }
    return { banned: false };
  }

  /** Временно блокирует только отправку сообщений (мягкая санкция). */
  isMuted(session) {
    return session.mutedUntil ? session.mutedUntil > Date.now() : false;
  }

  /**
   * Регистрирует жалобу на сессию. Возвращает факт бана, если он сработал.
   *
   * @param {import('./session.js').Session} target
   * @param {string} reason
   */
  recordReport(target, reason) {
    const code = REPORT_REASONS[reason] ? reason : 'other';
    const weight = REPORT_REASONS[code].weight;
    const now = Date.now();

    this.totals.reports += 1;
    const rec = this.strikes.get(target.id) || { score: 0, until: null, reasons: [], at: now };
    rec.score += weight;
    rec.at = now;
    if (!rec.reasons.includes(code)) rec.reasons.push(code);
    this.strikes.set(target.id, rec);

    const tally = this.reportReasons.get(code) || { count: 0, until: null };
    tally.count += 1;
    this.reportReasons.set(code, tally);

    if (rec.score >= config.banThreshold) {
      this.ban(target, code, config.banDurationMs);
      this.strikes.delete(target.id);
      return { banned: true, until: now + config.banDurationMs, permanent: false, reason: code };
    }
    return { banned: false, score: rec.score, remaining: config.banThreshold - rec.score };
  }

  /**
   * @param {import('./session.js').Session} session
   * @param {string} reason
   * @param {number} durationMs
   * @param {boolean} [permanent]
   */
  ban(session, reason, durationMs, permanent = false) {
    const until = permanent ? Number.MAX_SAFE_INTEGER : Date.now() + durationMs;
    this.bans.set(session.id, { sessionId: session.id, until, reason, permanent });
    // IP-бан — только при грубых нарушениях, чтобы один NAT не страдал из-за одного человека.
    if (session.ip && (reason === 'minors' || reason === 'nudity')) {
      this.bans.set(session.ip, { sessionId: session.id, until, reason, permanent });
    }
    this.totals.bans += 1;
    session.close(4003, `banned:${reason}`);
  }

  /** Мягкий бан чата за флуд/спам. */
  mute(session, durationMs, reason = 'spam') {
    session.mutedUntil = Date.now() + durationMs;
    session.muteReason = reason;
  }

  /** Сводка для /api/stats и диагностики. */
  snapshot() {
    return {
      ...this.totals,
      activeBans: this.bans.size,
      trackedSessions: this.strikes.size,
      reasons: Object.fromEntries([...this.reportReasons].map(([k, v]) => [k, v.count])),
    };
  }
}
