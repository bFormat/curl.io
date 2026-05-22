/* hud.js — 체력/탄/스킬쿨/킬피드/스코어보드 DOM 갱신. */
const $ = (id) => document.getElementById(id);

const SKILL_META = {
  repulse: { ic: '✷', name: 'Repulse' },
  bearing: { ic: '◉', name: 'Bearings' },
  dash:    { ic: '↣', name: 'Dash' }
};

export class HUD {
  constructor() {
    this.el = {
      hud: $('hud'), health: $('healthbar'), healthText: $('healthtext'),
      score: $('score'), ping: $('ping'),
      wp: $('w-primary'), ws: $('w-secondary'),
      s0: $('s0'), s1: $('s1'),
      killfeed: $('killfeed'), bearings: $('bearings'),
      death: $('deathmsg'), respawnCt: $('respawn-ct'),
      lock: $('lockmsg'), scoreboard: $('scoreboard')
    };
    this.weapons = null;
    this.skillDefs = null;
    this.skills = ['repulse', 'dash'];
    this.mapName = '';
  }

  configure(weapons, skillDefs, skills, mapName) {
    this.weapons = weapons;
    this.skillDefs = skillDefs;
    this.skills = skills;
    this.mapName = mapName || '';
    [this.el.s0, this.el.s1].forEach((slot, i) => {
      const meta = SKILL_META[skills[i]] || { name: skills[i] };
      slot.querySelector('.nm').textContent = meta.name;
    });
    this.el.hud.classList.remove('hidden');
  }

  setPing(rtt) { this.el.ping.textContent = Math.round(rtt); }

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
    // 체력
    const hp = Math.max(0, you.hp);
    this.el.health.style.width = hp + '%';
    this.el.healthText.textContent = Math.round(hp);
    this.el.health.style.background = hp > 50
      ? 'linear-gradient(#5ce06a,#2faf42)'
      : hp > 25 ? 'linear-gradient(#ffd23f,#d99a1f)'
      : 'linear-gradient(#ff6b6b,#c93b3b)';

    this.el.score.textContent = you.score;

    // 무기 쿨다운
    const primType = you.bearings > 0 ? 'bearing' : 'disc';
    this._cd(this.el.wp, you.fire.primary, this.weapons[primType].cooldown, now);
    this._cd(this.el.ws, you.fire.secondary, this.weapons.pushball.cooldown, now);
    this.el.wp.querySelector('b').textContent = you.bearings > 0 ? '쇠구슬' : '원판';

    // 스킬 쿨다운
    [this.el.s0, this.el.s1].forEach((slot, i) => {
      const id = you.skills[i];
      const def = this.skillDefs[id];
      if (!def) return;
      const readyAt = (you.cd && you.cd[id]) || 0;
      const remain = this._cd(slot, readyAt, def.cooldown, now);
      const rdy = slot.querySelector('.rdy');
      if (remain > 0) {
        slot.classList.remove('ready');
        rdy.textContent = Math.ceil(remain / 1000) + 's';
      } else {
        slot.classList.add('ready');
        rdy.textContent = '';
      }
    });

    // 쇠구슬 장전 표시
    if (you.bearings > 0) {
      this.el.bearings.classList.remove('hidden');
      this.el.bearings.querySelector('b').textContent = you.bearings;
    } else {
      this.el.bearings.classList.add('hidden');
    }

    // 사망 오버레이
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
      div.innerHTML = `<span class="a">${escapeHtml(ev.killerName)}</span> ⟶ <span class="v">${escapeHtml(ev.victimName)}</span>`;
    } else {
      div.innerHTML = `<span class="v">${escapeHtml(ev.victimName)}</span> 자멸`;
    }
    this.el.killfeed.appendChild(div);
    while (this.el.killfeed.children.length > 5) {
      this.el.killfeed.removeChild(this.el.killfeed.firstChild);
    }
    setTimeout(() => div.remove(), 5500);
  }

  showLock(show) {
    this.el.lock.classList.toggle('hidden', !show);
  }

  showScoreboard(show, players, selfId) {
    this.el.scoreboard.classList.toggle('hidden', !show);
    if (!show) return;
    const rows = [...players].sort((a, b) => b.score - a.score).map((p) => {
      const me = p.id === selfId ? ' class="me"' : '';
      return `<tr${me}><td>${escapeHtml(p.name)}</td><td>${p.kills}</td><td>${p.deaths}</td><td>${p.score}</td></tr>`;
    }).join('');
    this.el.scoreboard.innerHTML =
      `<h2>SCOREBOARD${this.mapName ? ' · ' + escapeHtml(this.mapName) : ''}</h2><table>
        <tr><th>플레이어</th><th>킬</th><th>데스</th><th>점수</th></tr>${rows}
      </table>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
