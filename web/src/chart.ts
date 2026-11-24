import {
  CandlestickSeries,
  createChart,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { applyPrice, bucketTime, INTERVALS, type Candle, type IntervalKey } from "../../shared/candles";
import { book } from "./pricebook";

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * 차트: 서버가 준 봉(체크포인트까지) + 클라이언트가 엔진으로 계산한 최근 구간을 이어 붙인다.
 * 새 틱이 오면 마지막 봉만 갱신한다.
 */
export class PriceChart {
  private chart: IChartApi;
  private candleSeries: ISeriesApi<"Candlestick">;
  private lineSeries: ISeriesApi<"Line">;
  private volumeSeries: ISeriesApi<"Histogram">;
  private candles: Candle[] = [];
  private stock = 0;
  private iv: IntervalKey = "1m";
  private lastTick = -1;
  private mode: "candle" | "line" = "candle";
  private legend: HTMLElement;
  private loadedKey = ""; // "stock:iv" — 응답이 늦게 와도 현재 선택과 맞는 것만 반영
  private avgLine: IPriceLine | null = null;
  private liqLine: IPriceLine | null = null;

  constructor(host: HTMLElement, legend: HTMLElement) {
    this.legend = legend;
    const up = css("--up");
    const down = css("--down");
    const grid = "#1a1e25";
    this.chart = createChart(host, {
      autoSize: true,
      layout: { background: { color: css("--panel") }, textColor: css("--text-2"), fontFamily: css("--font"), fontSize: 12 },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: css("--line") },
      timeScale: { borderColor: css("--line"), timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    this.candleSeries = this.chart.addSeries(CandlestickSeries, {
      upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down,
      priceFormat: { type: "price", precision: 0, minMove: 1 },
    });
    this.lineSeries = this.chart.addSeries(LineSeries, {
      color: css("--accent"), lineWidth: 2, visible: false,
      priceFormat: { type: "price", precision: 0, minMove: 1 },
    });
    this.volumeSeries = this.chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    this.chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    this.candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.22 } });

    this.chart.subscribeCrosshairMove((p) => {
      const d = p.seriesData.get(this.candleSeries) as { open: number; high: number; low: number; close: number } | undefined;
      if (d) this.showOhlc(d.open, d.high, d.low, d.close);
      else this.showLast();
    });
  }

  private fmt(n: number): string {
    return n.toLocaleString("ko-KR");
  }

  private showOhlc(o: number, h: number, l: number, c: number): void {
    const cls = c >= o ? "up" : "down";
    this.legend.innerHTML = "";
    const parts: [string, number][] = [["시", o], ["고", h], ["저", l], ["종", c]];
    for (const [label, v] of parts) {
      const span = document.createElement("span");
      span.className = label === "종" ? cls : "";
      span.textContent = `${label} ${this.fmt(v)}`;
      this.legend.appendChild(span);
    }
  }

  private showLast(): void {
    const c = this.candles[this.candles.length - 1];
    if (c) this.showOhlc(c.o, c.h, c.l, c.c);
  }

  setMode(mode: "candle" | "line"): void {
    this.mode = mode;
    this.candleSeries.applyOptions({ visible: mode === "candle" });
    this.lineSeries.applyOptions({ visible: mode === "line" });
  }

  /** 종목 또는 기간이 바뀌었을 때. 서버 응답(onCandles)을 기다린다. */
  select(stock: number, iv: IntervalKey): void {
    this.stock = stock;
    this.iv = iv;
    this.loadedKey = "";
    this.candles = [];
    this.render();
  }

  get key(): string {
    return `${this.stock}:${this.iv}`;
  }

  /** 서버가 계산해 보낸 봉(현재 tick까지)을 그대로 쓴다. */
  onCandles(stock: number, iv: IntervalKey, candles: Candle[], tick: number, vols: [number, number][]): void {
    if (stock !== this.stock || iv !== this.iv) return;
    const list = candles.map((c) => ({ ...c }));
    const volMap = new Map(vols);
    for (const c of list) c.v = volMap.get(c.t) ?? 0;
    this.candles = list;
    this.lastTick = tick;
    this.loadedKey = this.key;
    this.render();
    this.chart.timeScale().fitContent();
  }

  /** 실시간 체결 거래량을 현재 진행 중인 봉에 더한다. */
  addVolume(stock: number, qty: number): void {
    if (stock !== this.stock || this.loadedKey !== this.key) return;
    const c = this.candles[this.candles.length - 1];
    if (!c) return;
    c.v += qty;
    this.pushLast(c);
  }

  /** 내 평균 매수가(점선)와 청산가(점선)를 수평선으로 표시. null이면 제거. */
  setLines(avg: number | null, liq: number | null): void {
    if (this.avgLine) { this.candleSeries.removePriceLine(this.avgLine); this.avgLine = null; }
    if (this.liqLine) { this.candleSeries.removePriceLine(this.liqLine); this.liqLine = null; }
    if (avg !== null) {
      this.avgLine = this.candleSeries.createPriceLine({
        price: avg, color: css("--text-2"), lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "평균가",
      });
    }
    if (liq !== null) {
      this.liqLine = this.candleSeries.createPriceLine({
        price: liq, color: css("--warn"), lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "청산가",
      });
    }
  }

  /** 서버가 보낸 새 tick 가격: 마지막 봉만 갱신한다. */
  onPx(stock: number, tick: number, price: number): void {
    if (stock !== this.stock || this.loadedKey !== this.key || tick <= this.lastTick) return;
    this.lastTick = tick;
    applyPrice(this.candles, bucketTime(tick, book.epoch, book.tickMs, INTERVALS[this.iv]), price);
    this.pushLast(this.candles[this.candles.length - 1]);
  }

  private pushLast(c: Candle): void {
    const time = c.t as UTCTimestamp;
    this.candleSeries.update({ time, open: c.o, high: c.h, low: c.l, close: c.c });
    this.lineSeries.update({ time, value: c.c });
    this.volumeSeries.update({ time, value: c.v, color: c.c >= c.o ? "rgba(242,54,69,0.35)" : "rgba(47,128,237,0.35)" });
    this.showLast();
  }

  private render(): void {
    const t = (c: Candle) => c.t as UTCTimestamp;
    this.candleSeries.setData(this.candles.map((c) => ({ time: t(c), open: c.o, high: c.h, low: c.l, close: c.c })));
    this.lineSeries.setData(this.candles.map((c) => ({ time: t(c), value: c.c })));
    this.volumeSeries.setData(
      this.candles.map((c) => ({ time: t(c), value: c.v, color: c.c >= c.o ? "rgba(242,54,69,0.35)" : "rgba(47,128,237,0.35)" })),
    );
    if (this.candles.length) this.showLast();
    else this.legend.textContent = "";
  }

  destroy(): void {
    this.chart.remove();
  }
}
