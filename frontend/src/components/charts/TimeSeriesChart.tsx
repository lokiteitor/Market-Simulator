/**
 * TimeSeriesChart — envoltorio fino sobre Recharts <LineChart> con el estilo del
 * proyecto (ejes theme-aware vía currentColor, tooltip propio). Para tendencias
 * del panel admin (agentes, capital, volumen a lo largo del tiempo).
 */
import type { ReactNode } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import styles from "./charts.module.css";
import { colorAt, GRID_STROKE } from "./palette";

export interface TimeSeriesSeries {
  key: string;
  label: string;
}

export interface TimeSeriesChartProps<T extends Record<string, unknown>> {
  title?: string;
  data: ReadonlyArray<T>;
  xKey: keyof T & string;
  series: ReadonlyArray<TimeSeriesSeries>;
  height?: number;
  /** Formatea el valor del eje Y y del tooltip (p. ej. fmtMoney). */
  valueFormatter?: (value: number) => string;
  /** Formatea la etiqueta del eje X y del tooltip (p. ej. fecha corta). */
  xFormatter?: (value: string) => string;
}

/** Props que Recharts inyecta al `content` del Tooltip (tipado laxo local). */
interface InjectedTooltip {
  active?: boolean;
  label?: string | number;
  payload?: Array<{
    dataKey?: string | number;
    name?: ReactNode;
    value?: number | string;
    color?: string;
  }>;
}

export function TimeSeriesChart<T extends Record<string, unknown>>({
  title,
  data,
  xKey,
  series,
  height = 260,
  valueFormatter,
  xFormatter,
}: TimeSeriesChartProps<T>) {
  const renderTooltip = (p: InjectedTooltip): ReactNode => {
    if (p.active !== true || p.payload === undefined || p.payload.length === 0) return null;
    const rawLabel = typeof p.label === "string" ? p.label : String(p.label ?? "");
    return (
      <div className={styles.tooltip}>
        <p className={styles.tooltipLabel}>{xFormatter ? xFormatter(rawLabel) : rawLabel}</p>
        {p.payload.map((entry) => {
          const value =
            typeof entry.value === "number" ? entry.value : Number(entry.value ?? 0);
          return (
            <div key={String(entry.dataKey)} className={styles.tooltipRow}>
              <span className={styles.tooltipSwatch} style={{ background: entry.color }} />
              <span>{entry.name}</span>
              <span className={styles.tooltipValue}>
                {valueFormatter ? valueFormatter(value) : value.toLocaleString("es")}
              </span>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className={styles.frame}>
      {title !== undefined && <p className={styles.title}>{title}</p>}
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data as T[]} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
          <CartesianGrid stroke={GRID_STROKE} vertical={false} />
          <XAxis
            dataKey={xKey as never}
            tick={{ fill: "currentColor", fontSize: 11 }}
            tickFormatter={xFormatter}
            stroke={GRID_STROKE}
            minTickGap={24}
          />
          <YAxis
            tick={{ fill: "currentColor", fontSize: 11 }}
            tickFormatter={valueFormatter}
            stroke={GRID_STROKE}
            width={56}
          />
          <Tooltip content={renderTooltip as never} />
          {series.map((s, i) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key as never}
              name={s.label}
              stroke={colorAt(i)}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
