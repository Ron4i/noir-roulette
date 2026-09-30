import { randomBytes } from 'node:crypto';

import { config } from './config.js';

/**
 * Тематические комнаты: несколько человек общаются в одном топике.
 * В отличие от случайной пары, у комнаты есть владелец и постоянный состав,
 * а сообщения видят все гости.
 */
export class Room {
  /** @param {import('./session.js').Session} owner */
  constructor(owner, { title, topic = 'justchat', isPublic = true } = {}) {
    this.id = randomBytes(4).toString('hex');
    this.title = String(title || 'Новая комната').slice(0, 48) || 'Новая комната';
    this.topic = topic;
    this.isPublic = isPublic;
    this.ownerId = owner.id;
    this.createdAt = Date.now();
    this.messages = [];
    /** @type {Set<import('./session.js').Session>} */
    this.guests = new Set([owner]);
  }

  get size() {
    return this.guests.size;
  }

  get isFull() {
    return this.guests.size >= config.maxRoomGuests;
  }

  has(session) {
    return this.guests.has(session);
  }

  /**
   * @param {import('./session.js').Session} session
   * @returns {{ok:true}|{ok:false, code:string}}
   */
  join(session) {
    if (this.has(session)) return { ok: true };
    if (this.isFull) return { ok: false, code: 'room_full' };
    this.guests.add(session);
    session.room = this;
    return { ok: true };
  }

  /** @param {import('./session.js').Session} session */
  leave(session) {
    this.guests.delete(session);
    if (session.room === this) session.room = null;
    // Комната без людей и без владельца вырождается сама.
    if (this.guests.size === 0) this.ownerId = null;
  }

  /** @param {{text:string, from:string}} entry */
  pushMessage(entry) {
    this.messages.push({ ...entry, at: Date.now() });
    if (this.messages.length > config.maxRetainedEvents) this.messages.shift();
  }

  /**
   * Кто может писать в комнате: только гости, которые сейчас не в паре с кем-то другим.
   * @param {import('./session.js').Session} session
   */
  canSpeak(session) {
    return this.has(session) && (session.peerId === null || session.peer?.room === this);
  }
}

/** Реестр комнат: создание, поиск, каталог публичных. */
export class RoomRegistry {
  constructor({ onBroadcast } = {}) {
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    this.onBroadcast = onBroadcast || (() => {});
  }

  get size() {
    return this.rooms.size;
  }

  /**
   * @param {import('./session.js').Session} session
   * @param {{title:string, topic:string, isPublic?:boolean}} options
   */
  create(session, options) {
    const room = new Room(session, options);
    this.rooms.set(room.id, room);
    return room;
  }

  /** @param {string} id */
  get(id) {
    return this.rooms.get(id) || null;
  }

  /**
   * @param {import('./session.js').Session} session
   * @param {Room} room
   * @param {string} text
   */
  broadcast(room, from, text) {
    const payload = { type: 'room:chat', room: room.id, text, from: from.color, at: Date.now() };
    room.pushMessage({ text, from: from.color });
    for (const guest of room.guests) guest.send(payload);
  }

  /** Удалить комнату, если она опустела или владелец ушёл и гостей не осталось. */
  maybeDispose(room) {
    if (room.guests.size > 0) return false;
    this.rooms.delete(room.id);
    return true;
  }

  /** Публичный каталог для лендинга. */
  catalog() {
    return [...this.rooms.values()]
      .filter((r) => r.isPublic && r.guests.size > 0)
      .map((r) => ({
        id: r.id,
        title: r.title,
        topic: r.topic,
        guests: r.guests.size,
        max: config.maxRoomGuests,
      }))
      .sort((a, b) => b.guests - a.guests)
      .slice(0, 12);
  }
}
