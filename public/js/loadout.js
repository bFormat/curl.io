/* loadout.js — 무기/스킬 카탈로그 + 로드아웃 선택 패널 (메뉴·리스폰 화면 공용). */

export const CATALOG = {
  primary: [
    { id: 'disc', ic: '◉', name: '원판', desc: '균형 · 큰 히트박스' },
    { id: 'ironball', ic: '⏺', name: '쇠구슬', desc: '저격 55뎀 · 느린연사' },
    { id: 'pencil', ic: '✎', name: '연필', desc: '속사 · 단발 12뎀' },
    { id: 'bow', ic: '➴', name: '활', desc: '차징 곡사 · 최대 80' },
    { id: 'eraser', ic: '▭', name: '지우개', desc: '성장 · 최대 100' }
  ],
  secondary: [
    { id: 'pushball', ic: '◯', name: '큰 공', desc: '강한 넉백' },
    { id: 'stickybomb', ic: '✸', name: '점착폭탄', desc: '부착 후 폭발' },
    { id: 'jumppack', ic: '⤒', name: '점프팩', desc: '도약 + 주변뎀' }
  ],
  skills: [
    { id: 'repulse', ic: '✷', name: 'Repulse', desc: '폭발 + 밀침' },
    { id: 'bearing', ic: '◎', name: 'Bearings', desc: '쇠구슬 2발' },
    { id: 'dash', ic: '↣', name: 'Dash', desc: '전방 돌진' }
  ]
};

export const DEFAULT_LOADOUT = { primary: 'disc', secondary: 'pushball', skills: ['repulse', 'dash'] };

// container 안에 선택 패널을 그린다. loadout 객체를 직접 변경하고 onChange 호출.
export function buildPicker(container, loadout, onChange, compact) {
  function render() {
    container.innerHTML = '';
    container.className = compact ? 'loadout compact' : 'loadout';
    container.appendChild(row('primary', '주무기', CATALOG.primary, 'single'));
    container.appendChild(row('secondary', '보조무기', CATALOG.secondary, 'single'));
    container.appendChild(row('skills', '스킬 (2개)', CATALOG.skills, 'multi'));
  }

  function row(key, label, items, mode) {
    const r = document.createElement('div');
    r.className = 'lo-row';
    const lab = document.createElement('div');
    lab.className = 'lo-label';
    lab.textContent = label;
    r.appendChild(lab);
    const cards = document.createElement('div');
    cards.className = 'lo-cards';
    for (const it of items) {
      const sel = mode === 'single'
        ? loadout[key] === it.id
        : loadout.skills.includes(it.id);
      const c = document.createElement('div');
      c.className = 'lo-card' + (sel ? ' sel' : '');
      c.innerHTML =
        `<div class="lo-ic">${it.ic}</div>` +
        `<div class="lo-nm">${it.name}</div>` +
        `<div class="lo-ds">${it.desc}</div>`;
      c.onclick = () => {
        if (mode === 'single') {
          loadout[key] = it.id;
        } else {
          if (loadout.skills.includes(it.id)) {
            loadout.skills = loadout.skills.filter((s) => s !== it.id);
          } else {
            loadout.skills.push(it.id);
            if (loadout.skills.length > 2) loadout.skills.shift();
          }
        }
        render();
        if (onChange) onChange(loadout);
      };
      cards.appendChild(c);
    }
    r.appendChild(cards);
    return r;
  }

  render();
}
