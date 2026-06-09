/* server/protocol.js — 메시지 타입 상수 + 직렬화 헬퍼 */
'use strict';

const C2S = {
  JOIN: 'JOIN',
  INPUT: 'INPUT',
  FIRE_START: 'FIRE_START',
  FIRE_RELEASE: 'FIRE_RELEASE',
  USE_SKILL: 'USE_SKILL',
  SET_LOADOUT: 'SET_LOADOUT',
  PING: 'PING'
};

const S2C = {
  WELCOME: 'WELCOME',
  SNAPSHOT: 'SNAPSHOT',
  PONG: 'PONG'
};

function encode(obj) {
  return JSON.stringify(obj);
}

function decode(buf) {
  try {
    return JSON.parse(typeof buf === 'string' ? buf : buf.toString());
  } catch (e) {
    return null;
  }
}

module.exports = { C2S, S2C, encode, decode };
