/* server/protocol.js — 메시지 타입 상수 + 직렬화 헬퍼 */
'use strict';

// C→S
const C2S = {
  JOIN: 'JOIN',
  INPUT: 'INPUT',
  FIRE: 'FIRE',
  USE_SKILL: 'USE_SKILL',
  PING: 'PING'
};

// S→C
const S2C = {
  WELCOME: 'WELCOME',
  SNAPSHOT: 'SNAPSHOT',
  EVENT: 'EVENT',
  PONG: 'PONG',
  ERROR: 'ERROR'
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
