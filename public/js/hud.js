/* hud.js — 체력/무기·스킬쿨/차지바/킬피드/스코어보드 DOM 갱신. v0.2 */
import { CATALOG } from './loadout.js';

const $ = (id) => document.getElementById(id);

const BY_ID = {};
for (const k of ['primary', 'secondary', 'skills']) {
  for (const it of CATALOG[k]) BY_ID[it.id] = it;
}

export class HUD {
  constructor() {
    this.el = {
      hud: $('hud'), health: $('healthbar'), healthText: $('healthtext'),
      score: $('score'), ping: $('ping'),
      wp: $('w-primary'), ws: $('w-secondary'),
      s0: $('s0'), s1: $('s1'),
      killfeed: $('killfeed'), bearings: $('bearings'),
      death: $('deathmsg'), respawnCt: $('respawn-ct'),
      lock: $('lockmsg'), scoreboard: $('scoreboard'),
      chargebar: $('chargebar'), chargefill: $('chargefill'),
      hitmarker: $('hitmarker')
    };
    this.defs = null;
    this.mapName = '';
  }

  configure(defs, mapName) {
    this.defs = defs;          // {primary, secondary, skills, bearingProj}
    this.mapName = mapName || '';
    this.el.hud.classList.remove('hidden');
  }

  setPing(rtt) { this.el.ping.textContent = Math.round(rtt); }

  setCharge(active, frac) {
    if (!active) { this.el.chargebar.classList.add('hidden'); return; }
    this.el.chargebar.classList.remove('hidden');
    this.el.chargefill.style.width = Math.max(0, Math.min(1, frac)) * 100 + '%';
  }

  _cd(el, readyAt, total, now) {
    const bar = el.querySelector('.cd');
    const remain = readyAt - now;
    if (remain > 0 && total > 0) {
      bar.style.height = Math.min(100, (remain / total) * 100) + '%';
      return remain;
    }
    bar.style.height = '0%';
    return 0;
  }

  update(you, now) {
    const hp = Math.max(0, you.hp);
    this.el.health.style.width = hp + '%';
    this.el.healthText.textContent = Math.round(hp);
    this.el.health.style.background = hp > 50
      ? 'linear-gradient(#5ce06a,#2faf42)'
      : hp > 25 ? 'linear-gradient(#ffd23f,#d99a1f)'
      : 'linear-gradient(#ff6b6b,#c93b3b)';
    this.el.score.textContent = you.score;

    const lo = you.loadout || { primary: 'disc', secondary: 'pushball', skills: ['repulse', 'dash'] };
    const bearing = you.bearings > 0;

    // 주무기
    const pIc = bearing ? '◎' : (BY_ID[lo.primary] || {}).ic || '?';
    const pNm = bearing ? '쇠구슬' : (BY_ID[lo.primary] || {}).name || lo.primary;
    const pCd = bearing ? this.defs.bearingProj.cooldown : this.defs.primary[lo.primary].cooldown;
    this.el.wp.querySelector('.ic').textContent = pIc;
    this.el.wp.querySelector('.nm').textContent = pNm;
    this._cd(this.el.wp, you.fire.primary, pCd, now);

    // 보조무기
    const sec = BY_ID[lo.secondary] || {};
    this.el.ws.querySelector('.ic').textContent = sec.ic || '?';
    this.el.ws.querySelector('.nm').textContent = sec.name || lo.secondary;
    this._cd(this.el.ws, you.fire.secondary, this.defs.secondary[lo.secondary].cooldown, now);

    // 스킬 2슬롯
    [this.el.s0, this.el.s1].forEach((slot, i) => {
      const id = lo.skills[i];
      const def = this.defs.skills[id];
      slot.querySelector('.nm').textContent = (BY_ID[id] || {}).name || id || '-';
      if (!def) { slot.querySelector('.cd').style.height = '0%'; return; }
      const remain = this._cd(slot, (you.cd && you.cd[id]) || 0, def.cooldown, now);
      const rdy = slot.querySelector('.rdy');
      if (remain > 0) { slot.classList.remove('ready'); rdy.textContent = Math.ceil(remain / 1000) + 's'; }
      else { slot.classList.add('ready'); rdy.textContent = ''; }
    });

    if (you.bearings > 0) {
      this.el.bearings.classList.remove('hidden');
      this.el.bearings.querySelector('b').textContent = you.bearings;
    } else {
      this.el.bearings.classList.add('hidden');
    }

    if (!you.alive) {
      this.el.death.classList.remove('hidden');
      const left = you.respawnAt ? Math.max(0, Math.ceil((you.respawnAt - now) / 1000)) : 0;
      this.el.respawnCt.textContent = left;
    } else {
      this.el.death.classList.add('hidden');
    }
  }

  pushKill(ev) {
    const div = document.createElement('div');
    div.className = 'kf';
    if (ev.killerName) {
      div.innerHTML = `<span class="a">${esc(ev.killerName)}</span> ⟶ <span class="v">${esc(ev.victimName)}</span>`;
    } else {
      div.innerHTML = `<span class="v">${esc(ev.victimName)}</span> 자멸`;
    }
    this.el.killfeed.appendChild(div);
    while (this.el.killfeed.children.length > 5) {
      this.el.killfeed.removeChild(this.el.killfeed.firstChild);
    }
    setTimeout(() => div.remove(), 5500);
  }

  // 적중 히트마커 — 애니메이션 재시작을 위해 클래스 토글 + 리플로우
  hitmarker(kill) {
    const el = this.el.hitmarker;
    el.classList.remove('hit', 'kill');
    void el.offsetWidth;
    el.classList.add('hit');
    if (kill) el.classList.add('kill');
  }

  showLock(show) { this.el.lock.classList.toggle('hidden', !show); }

  showScoreboard(show, players, selfId) {
    this.el.scoreboard.classList.toggle('hidden', !show);
    if (!show) return;
    const rows = [...players].sort((a, b) => b.score - a.score).map((p) => {
      const me = p.id === selfId ? ' class="me"' : '';
      return `<tr${me}><td>${esc(p.name)}</td><td>${p.kills}</td><td>${p.deaths}</td><td>${p.score}</td></tr>`;
    }).join('');
    this.el.scoreboard.innerHTML =
      `<h2>SCOREBOARD${this.mapName ? ' · ' + esc(this.mapName) : ''}</h2><table>
        <tr><th>플레이어</th><th>킬</th><th>데스</th><th>점수</th></tr>${rows}
      </table>`;
  }
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
