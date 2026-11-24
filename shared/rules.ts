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
  ABNORMAL_RATE: 5, // 수익률이 시작 자금의 이 배수(+500%)를 넘으면 관리자 화면에 표시 (조치는 관리자가 판단)
  LB_TOP: 100, // 리더보드에 보여 주는 순위 수
  HOF_TOP: 20, // 명예의 전당에 보관하는 순위 수

  // 계좌
  START_CASH: 10_000_000,
  FEE_RATE: 0.001,

  // 가격 모델
  PRICE_FLOOR: 100,
  PRICE_REVERT: 0.00002, // 틱당 기준가로 되돌아가는 비율
  JUMP_PROB: 0.0004, // 틱당 점프 확률 (약 1.4시간에 한 번)
  JUMP_SIZE: 0.03, // 점프 기본 크기 (비율, 0.5~1.5배로 흔들림)

  // 레버리지
  LEVERAGES: [1, 2, 3, 5] as const,
  MAINTENANCE_MARGIN: 0.25, // 내 증거금 대비 남은 순자산이 이 비율 미만이면 강제 청산 (레버리지 2배 이상)

  // 공매도
  SHORT_MARGIN: 1.5, // 진입 금액 대비 잠그는 증거금 비율
  SHORT_MAINTENANCE: 1.0, // 공매도 순자산이 (현재가×수량)의 이 비율 미만이면 강제 청산

  // 파산 구제
  BAILOUT_AMOUNT: 1_000_000,
  BAILOUT_PER_DAY: 1,

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

  // 프레스티지
  PRESTIGE_NET_WORTH: 1_000_000_000,
  PRESTIGE_BONUS_PER_STAR: 0.1,

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
} as const;

export type Profile = keyof typeof VOLATILITY;
