/**
 * CategoryBarChart — envoltorio fino sobre Recharts <BarChart> con el estilo del
 * proyecto. Para comparativas por categoría del panel admin (volumen por
 * producto, producción por producto, etc.). Una sola serie de valores.
 */
import type { ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import styles from "./charts.module.css";
import { colorAt, GRID_STROKE } from "./palette";

export interface CategoryBarChartProps<T extends Record<string, unknown>> {
  title?: string;
  data: ReadonlyArray<T>;
  /** Clave de la etiqueta de categoría (eje X). */
  categoryKey: keyof T & string;
  /** Clave del valor numérico (eje Y). */
  valueKey: keyof T & string;
  valueLabel: string;
  height?: number;
  valueFormatter?: (value: number) => string;
}

interface InjectedTooltip {
  active?: boolean;
  payload?: Array<{
    value?: number | string;
    payload?: Record<string, unknown>;
  }>;
}

export function CategoryBarChart<T extends Record<string, unknown>>({
  title,
  data,
  categoryKey,
  valueKey,
  valueLabel,
  height = 260,
  valueFormatter,
}: CategoryBarChartProps<T>) {
  // Recharts necesita el label en el datum para el tooltip: se proyecta a __label.
  const rows = data.map((d) => ({ ...d, __label: String(d[categoryKey] ?? "") }));

  const renderTooltip = (p: InjectedTooltip): ReactNode => {
    if (p.active !== true || p.payload === undefined || p.payload.length === 0) return null;
    const entry = p.payload[0];
    if (entry === undefined) return null;
    const value = typeof entry.value === "number" ? entry.value : Number(entry.value ?? 0);
    const label = entry.payload?.["__label"];
    return (
      <div className={styles.tooltip}>
        <p className={styles.tooltipLabel}>{typeof label === "string" ? label : ""}</p>
        <div className={styles.tooltipRow}>
          <span>{valueLabel}</span>
          <span className={styles.tooltipValue}>
            {valueFormatter ? valueFormatter(value) : value.toLocaleString("es")}
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className={styles.frame}>
      {title !== undefined && <p className={styles.title}>{title}</p>}
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
          <CartesianGrid stroke={GRID_STROKE} vertical={false} />
          <XAxis
            dataKey={categoryKey as never}
            tick={{ fill: "currentColor", fontSize: 11 }}
            stroke={GRID_STROKE}
            interval={0}
            angle={-20}
            textAnchor="end"
            height={54}
          />
          <YAxis
            tick={{ fill: "currentColor", fontSize: 11 }}
            tickFormatter={valueFormatter}
            stroke={GRID_STROKE}
            width={56}
          />
          <Tooltip cursor={{ fill: "rgba(127,127,127,0.08)" }} content={renderTooltip as never} />
          <Bar dataKey={valueKey as never} name={valueLabel} radius={[3, 3, 0, 0]} isAnimationActive={false}>
            {rows.map((_, i) => (
              <Cell key={i} fill={colorAt(i)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
