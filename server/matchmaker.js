/* server/matchmaker.js — 빈 자리 있는 룸 찾기 / 생성. */
'use strict';

const { Room } = require('./room');

class Matchmaker {
  constructor() {
    this.rooms = new Set();
  }

  // 입장 가능한 룸 중 가장 먼저 찬(인원 많은) 룸 선택, 없으면 생성.
  assign() {
    let best = null;
    for (const room of this.rooms) {
      if (!room.isJoinable) continue;
      if (!best || room.size > best.size) best = room;
    }
    if (!best) {
      best = new Room((r) => this.rooms.delete(r));
      this.rooms.add(best);
    }
    return best;
  }

  stats() {
    let players = 0;
    for (const r of this.rooms) players += r.size;
    return { rooms: this.rooms.size, players };
  }
}

module.exports = Matchmaker;
