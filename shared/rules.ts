// 게임 규칙 수치는 전부 여기에만 둔다.

export const RULES = {
  // 시간
  TICK_MS: 2000,
  CHECKPOINT_MS: 600_000, // 체크포인트·OHLC 저장 주기 (10분)
  LEADERBOARD_MS: 60_000, // 리더보드 집계 주기 (1분)
  EVENT_MAX_ABS_PCT: 50, // 이벤트 한 건의 최대 변동률(±%)
  EVENT_MAX_DURATION_MIN: 720, // 이벤트 최대 지속 시간(분)
  EVENT_MIN_LEAD_TICKS: 2, // 이벤트 시작은 현재 tick보다 최소 이만큼 뒤여야 한다 (과거 가격 불변)
  EVENT_MAX_AHEAD_MIN: 7 * 24 * 60, // 이벤트를 미리 등록할 수 있는 최대 기간(분)
  // 자동 이벤트: 서버가 접속자가 있는 동안 무작위로 만든다. 효과 시간을 짧게 하고 변동률을 작게 해서 뉴스를 보고 따라 사는 단타의 이득을 줄인다.
  AUTO_EVENT_MIN_GAP_SEC: 180, // 다음 이벤트까지의 간격은 이 범위에서 무작위 (접속자가 있는 동안만)
  AUTO_EVENT_MAX_GAP_SEC: 420,
  AUTO_EVENT_IDLE_GRACE_SEC: 60, // 예정 시각을 이보다 오래 지나쳤으면(접속자가 없던 경우) 간격을 새로 정한다
  // 뉴스 열람권: 이벤트 뉴스는 열람권이 있는 동안에만 볼 수 있다. 가격은 열람권과 상관없이 움직인다.
  NEWS_PASS_MIN: 30, // 열람 시간(분)
  NEWS_PASS_RATE: 0.1, // 가격 = 구매 시점 순자산의 이 비율
  AUTO_EVENT_MIN_PCT: 1.5, // 한 건의 변동률 범위(±%)
  AUTO_EVENT_MAX_PCT: 5,
  AUTO_EVENT_MIN_SEC: 60, // 가격이 움직이는 시간 범위(초, 10초 단위)
  AUTO_EVENT_MAX_SEC: 120,
  AUTO_EVENT_MAX_ACTIVE: 3, // 동시에 진행·예정인 이벤트 수 상한
  ABNORMAL_RATE: 5, // 수익률이 시작 자금의 이 배수(+500%)를 넘으면 관리자 화면에 표시 (조치는 관리자가 판단)
  LB_TOP: 100, // 리더보드에 보여 주는 순위 수
  HOF_TOP: 20, // 명예의 전당에 보관하는 순위 수

  // 계좌
  START_CASH: 10_000_000,
  FEE_RATE: 0.001,
  MACHO_FEE_RATES: { 10: 0.002, 20: 0.003, 30: 0.004, 50: 0.005 } as Record<number, number>, // 상남자 마켓 수수료율(레버리지별). 배율이 높을수록 비싸다.

  // 가격 모델
  PRICE_FLOOR: 100,
  PRICE_REVERT: 0.00002, // 틱당 기준가로 되돌아가는 비율
  JUMP_PROB: 0.0004, // 틱당 점프 확률 (약 1.4시간에 한 번)
  JUMP_SIZE: 0.03, // 점프 기본 크기 (비율, 0.5~1.5배로 흔들림)

  // 레버리지
  LEVERAGES: [1, 2, 3, 5] as const,
  MACHO_LEVERAGES: [10, 20, 30, 50] as const, // 상남자 마켓 전용. 50배는 약 1.5%만 반대로 움직여도 청산된다. 공매도는 불가.
  MAINTENANCE_MARGIN: 0.25, // 내 증거금 대비 남은 순자산이 이 비율 미만이면 강제 청산 (2배 이상 매수, 모든 공매도)

  LIQ_WARN_RATIO: 0.05, // 현재가가 청산가까지 이 비율 이내로 다가오면 경고 (표시 전용, 체결과 무관)

  // 공매도는 매수와 같은 레버리지(LEVERAGES)·증거금·청산 기준(MAINTENANCE_MARGIN)을 쓴다. 다만 1배도 청산이 있다(가격이 오르면 손실에 한도가 없으므로).

  // 파산 구제
  BAILOUT_AMOUNT: 1_000_000,
  BAILOUT_PER_DAY: 3,

  // 복권
  LOTTERY_PRICE: 10_000,
  LOTTERY_PER_DAY: 20,
  // 상금표 (가중치 합 10,000 = 100%). 기대값 약 84%.
  LOTTERY_PRIZES: [
    { payout: 0, weight: 6800 },
    { payout: 5_000, weight: 2000 },
    { payout: 10_000, weight: 800 },
    { payout: 30_000, weight: 270 },
    { payout: 100_000, weight: 100 },
    { payout: 1_000_000, weight: 28 },
    { payout: 10_000_000, weight: 2 },
  ],
  LOTTERY_FEED_MIN: 1_000_000, // 이 금액 이상 당첨되면 체결 피드에 알림

  // 블록 채우기 퍼즐: 조각을 정해진 칸에 빈틈없이 채우면 배당. 단계가 올라갈수록 판이 커지고 시간은 빠듯해진다.
  // 배당은 "현재까지 깬 단계 수"만 따라간다 (배팅액 × PAYOUT_MULT[깬 단계 - 1]). 중간에 멈추면 그 배당을 받고, 시간 초과면 배팅액을 잃는다.
  // 1·2단계만 깨고 정산하면 손해이고, 3단계를 깨야 비로소 이득이다. 길이는 PUZZLE_STAGES와 같아야 한다.
  PUZZLE_MIN_BET: 10_000,
  PUZZLE_MAX_BET: 1_000_000,
  PUZZLE_PAYOUT_MULT: [0.4, 0.7, 1.3, 2, 3, 4.5, 7],
  PUZZLE_GRACE_MS: 1500, // 네트워크 지연을 감안해 제한 시간에 더해 주는 여유 (화면 타이머는 이 여유를 포함하지 않는다)
  PUZZLE_FEED_MIN: 10_000_000, // 이 금액 이상 받으면 체결 피드에 알림
  // size: 한 변 칸 수 / minPiece·maxPiece: 조각 하나의 칸 수 범위 / seconds: 제한 시간
  PUZZLE_STAGES: [
    { size: 4, minPiece: 3, maxPiece: 5, seconds: 25 },
    { size: 5, minPiece: 3, maxPiece: 5, seconds: 40 },
    { size: 6, minPiece: 3, maxPiece: 5, seconds: 55 },
    { size: 7, minPiece: 3, maxPiece: 6, seconds: 75 },
    { size: 8, minPiece: 3, maxPiece: 6, seconds: 95 },
    { size: 9, minPiece: 4, maxPiece: 6, seconds: 120 },
    { size: 10, minPiece: 4, maxPiece: 7, seconds: 150 },
  ],

  // 알바: 배팅 없이 일한 만큼 번다 (현금이 0원이어도 가능). 하루 한도는 없고, 수입은 근무 시간 안에서 할 수 있는 만큼으로 제한된다.
  // unit: 한 번 잘했을 때의 기본 수입(원) / shiftSec: 근무 시간(초, 0이면 시간 제한 없이 단계별 진행)
  PT_JOBS: {
    calc: { title: "계산 알바", unit: 300, shiftSec: 40 }, // 정답 하나당 unit, 오답 하나당 -unit/2
    memory: { title: "순서 기억 알바", unit: 800, shiftSec: 0 }, // 라운드 r을 성공하면 unit×r
    match: { title: "짝 맞추기 알바", unit: 1000, shiftSec: 60 }, // 맞춘 짝 하나당 unit (모두 맞추면 남은 시간만큼 보너스)
    fry: { title: "돈까스 튀기기", unit: 700, shiftSec: 45 }, // 완벽하게 꺼내면 unit, 괜찮으면 unit/2
  },
  PT_CALC_MIN_ANSWER_MS: 600, // 사람이 계산 문제 하나에 쓸 수 있는 최소 시간. 이보다 빠른 제출은 무효
  PT_MEMORY_MAX_ROUND: 12,
  PT_MEMORY_MENU: 4, // 메뉴 종류 수
  PT_MEMORY_SHOW_MS: 700, // 메뉴 하나를 보여 주는 시간
  PT_MATCH_PAIRS: 8, // 4×4 카드
  PT_MATCH_MIN_FLIP_MS: 200, // 카드를 뒤집는 최소 간격
  PT_MATCH_TIME_BONUS: 0.5, // 모두 맞췄을 때 남은 시간 비율 × 이 값 만큼 보너스
  PT_FRY_READY_MIN_MS: 2000, // 튀김이 완성되는 시각의 범위
  PT_FRY_READY_MAX_MS: 3500,
  PT_FRY_PERFECT_MS: 250, // 완성 시각과의 차이가 이 안이면 완벽
  PT_FRY_GOOD_MS: 600, // 이 안이면 괜찮음, 넘으면 실패
  PT_FRY_MAX_LAG_MS: 800, // 서버가 잰 시간보다 화면이 잰 시간이 이만큼 이상 짧으면 무효 (네트워크 지연 허용 한도)
  // 영구 업그레이드: 현금으로 사고, 레벨이 오를수록 비싸진다. 비용 = round(cost × growth^현재레벨, 백 원 단위)
  PT_UPGRADES: [
    { id: "wage", title: "시급 인상", desc: "모든 알바 수입 +10%", max: 20, cost: 30_000, growth: 1.35 },
    { id: "time", title: "근무 시간 연장", desc: "근무 시간 +3초 (순서 기억 제외)", max: 10, cost: 50_000, growth: 1.4 },
    { id: "calc", title: "전자계산기", desc: "계산 알바 수입 +15%", max: 10, cost: 40_000, growth: 1.4 },
    { id: "memory", title: "메모장", desc: "순서 기억 알바 수입 +15%", max: 10, cost: 40_000, growth: 1.4 },
    { id: "match", title: "카드 정리함", desc: "짝 맞추기 알바 수입 +15%", max: 10, cost: 40_000, growth: 1.4 },
    { id: "fry", title: "고급 튀김기", desc: "돈까스 튀기기 수입 +15%", max: 10, cost: 40_000, growth: 1.4 },
  ],
  PT_WAGE_PER_LEVEL: 0.1,
  PT_TIME_PER_LEVEL_SEC: 3,
  PT_JOB_PER_LEVEL: 0.15,

  // 프레스티지
  PRESTIGE_NET_WORTH: 1_000_000_000,
  PRESTIGE_BONUS_PER_STAR: 0.1,

  // 예약 주문 (지정가 · 손절 · 익절)
  RESERVE_MAX: 10, // 유저당 동시에 걸어 둘 수 있는 예약 수
  RESERVE_TTL_MS: 7 * 24 * 3600 * 1000, // 이 기간이 지나면 자동 취소
  RESERVE_KEEP: 30, // 체결·실패·취소된 예약을 유저당 보관하는 개수
  RESERVE_STOP_PCT: 0.05, // 손절 빠른 입력: 평균가 대비 (표시 전용)
  RESERVE_TAKE_PCT: 0.1, // 익절 빠른 입력: 평균가 대비 (표시 전용)

  // 일일 미션 · 업적 (진행도는 거래 기록에서 계산하고, 미션 보상 수령 여부만 따로 저장한다)
  MISSION_MIN_NOTIONAL: 100_000, // 이 금액 미만의 거래는 미션에 세지 않는다 (소액 반복으로 보상을 노리는 것을 막음)
  MISSIONS_PER_DAY: 3,
  MISSION_POOL: [
    { id: "trades5", kind: "trades", target: 5, reward: 100_000, title: "5번 거래하기" },
    { id: "trades10", kind: "trades", target: 10, reward: 200_000, title: "10번 거래하기" },
    { id: "stocks3", kind: "stocks", target: 3, reward: 100_000, title: "서로 다른 3종목 거래하기" },
    { id: "profit1", kind: "profits", target: 1, reward: 100_000, title: "수익 내고 정리 1회" },
    { id: "profit3", kind: "profits", target: 3, reward: 250_000, title: "수익 내고 정리 3회" },
    { id: "lottery3", kind: "lottery", target: 3, reward: 30_000, title: "복권 3장 사기" },
    { id: "volume5m", kind: "volume", target: 5_000_000, reward: 150_000, title: "거래대금 500만 원 달성" },
  ],
  ACHIEVEMENTS: [
    { id: "first_trade", kind: "trades", target: 1, title: "첫 거래", desc: "처음으로 주식을 사고팔았다" },
    { id: "trades100", kind: "trades", target: 100, title: "단골 투자자", desc: "거래 100회" },
    { id: "profit10", kind: "profits", target: 10, title: "수익 습관", desc: "수익을 내고 정리 10회" },
    { id: "profit50", kind: "profits", target: 50, title: "승부사", desc: "수익을 내고 정리 50회" },
    { id: "lev5profit", kind: "lev5profit", target: 1, title: "아슬아슬한 성공", desc: "5배 레버리지로 수익 정리" },
    { id: "liq1", kind: "liquidations", target: 1, title: "쓰라린 경험", desc: "강제 청산을 당했다" },
    { id: "realized10m", kind: "realized", target: 10_000_000, title: "천만 원의 벽", desc: "누적 실현손익 1,000만 원" },
    { id: "lottery_big", kind: "lotteryMax", target: 1_000_000, title: "복권 대박", desc: "복권 한 번 구매로 100만 원 이상 당첨" },
    { id: "prestige1", kind: "prestiges", target: 1, title: "새로운 시작", desc: "프레스티지 달성" },
  ],

  // 기타
  ORDERS_PER_SEC: 5,
  MAX_ORDER_QTY: 1_000_000, // 1회 주문 최대 수량
  USER_TRADE_IMPACT: false, // 유저 거래의 가격 영향 (기능 플래그)
} as const;

// 종목 성격별 틱당 변동성(표준편차, 비율)
export const VOLATILITY = {
  stable: 0.0003,
  normal: 0.0006,
  volatile: 0.0012,
  coin: 0.002,
  macho: 0.004, // 상남자 마켓: 코인의 두 배. 1분에 평균 2% 안팎으로 출렁인다.
} as const;

// 종목 성격별 틱당 추세(비율). 없으면 0. 상남자 마켓은 오르는 쪽보다 내리는 쪽으로 약하게 기울어 있어서 오래 들고 있을수록 불리하다.
export const DRIFT: Partial<Record<keyof typeof VOLATILITY, number>> = {
  macho: -0.00002,
};

export type Profile = keyof typeof VOLATILITY;
