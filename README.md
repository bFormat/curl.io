# curl.io

원판을 굴려 쏘는 단순 디자인 멀티플레이어 FPS. krunker.io 형태의 자동 매치메이킹 io 게임.

## 실행

```bash
npm install
npm start
# → http://localhost:3000
```

테스트:
```bash
npm test    # 서버를 먼저 띄운 상태에서 실행 (npm start)
```

## 조작

- **WASD** 이동, **Space** 점프
- **마우스** 조준 (포인터락) · **좌클릭** 주무기 · **우클릭** 보조
- **Shift** / **E** 스킬 1/2
- **Tab** 스코어보드
- 활은 좌클릭을 눌러 **차징**, 떼면 발사

리스폰 화면(사망 후 3초)에서 주무기/보조/스킬을 다시 고를 수 있다.

## 무기

| 슬롯 | 종류 |
|---|---|
| 주무기 | `disc`(원판·균형) · `ironball`(저격) · `pencil`(속사) · `bow`(차징 곡사) · `eraser`(성장 폭딜) |
| 보조 | `pushball`(넉백) · `stickybomb`(부착 후 폭발) · `jumppack`(도약+AOE) |
| 스킬 | `repulse`(폭발+밀침) · `bearing`(저격 쇠구슬 2발 장전) · `dash`(전방 돌진) |

전 수치는 `server/weapons.js` 한 곳에서 관리. 클라엔 `WELCOME` 메시지로 전달된다.

## 아키텍처

```
[Browser]  ──WebSocket(JSON)──>  [Node]
  Three.js 렌더                     ws + http(static)
  입력 + 클라 예측                   매치메이커 + Room × N
  스냅샷 보간                        30Hz 권위 시뮬레이션
```

- **권위 모델**: 이동은 클라 예측 + 서버 reconciliation, 발사/충돌/데미지/스킬은 전부 서버 권위.
- **공유 시뮬**: `shared/sim.js`(이동·충돌)를 서버/클라가 똑같은 코드로 돌려 예측 일치를 보장.
- **틱**: 서버 30Hz self-schedule(드리프트 보정), 클라 입력 60Hz, 보간 100ms 지연.
- **충돌**: 직접 구현. 플레이어는 원기둥, 박스 AABB. 단차 0.55m 이하는 자동으로 올라선다(계단·2층). 투사체는 선분-구/AABB CCD + 모서리 둥글림.

### 디렉토리

```
server/
  index.js        http 정적 + WebSocket + 매치메이커 진입
  matchmaker.js   빈 자리 있는 룸 찾기/생성
  room.js         한 룸의 30Hz 시뮬 루프 (입력→발사→스킬→투사체→충돌→폭발→리스폰→방송)
  physics.js      선분-구 / 선분-AABB(모서리 둥글림 후처리)
  weapons.js      주/보조/스킬 데이터 테이블
  map.js          아레나 지오메트리(`box-arena`, `pillar-yard`)
  protocol.js     메시지 타입 상수 + JSON 헬퍼
shared/
  sim.js          결정론적 이동/충돌 (서버=클라 동일 코드, UMD)
public/
  index.html      메뉴 + 캔버스 + HUD
  style.css
  vendor/three.module.js   three.js 벤더링(0.160.0)
  js/
    main.js       렌더 루프 / 입력 / 예측 / 보간 오케스트레이션
    net.js        WebSocket + 자동 재접속(지수 백오프)
    render.js     Three.js 씬 / 6파트 캐릭터 / 풀링된 투사체·이펙트 / 뷰모델
    hud.js        체력 / 쿨다운 / 차지바 / 히트마커 / 킬피드 / 스코어보드
    loadout.js    로드아웃 선택 패널 (메뉴·리스폰 공용)
    audio.js      WebAudio 합성 효과음
test/
  smoke.js        엔드투엔드 + 단위 검증 (계단·벽 충돌·투사체 모서리·5무기/3보조/차징·성장·점착·점프팩·안티치트·SET_LOADOUT)
```

## 안티치트

- 입력 dt 예산: 틱당 처리량을 1.5× 상한으로 제한 → 입력 폭주로 속도 뻥튀기 불가.
- 발사/스킬 쿨다운, 자기 피격 무시, 사망자 입력 폐기 — 전부 서버 권위.

## 성능

- 투사체·이펙트 메시 풀링 — 런타임 지오메트리 할당 0(연필 난사 시 GC 튐 제거).
- 스냅샷 공유부(players/projectiles/events)는 1회만 직렬화 후 클라별로 `ack`/`you`만 합성.
- 그림자맵 1024, PCF, 픽셀비율 1.5 상한, 투사체 그림자 캐스팅 해제.
- HUD DOM 갱신은 60→20Hz 스로틀(차지바·포인터락 안내만 매프레임).
