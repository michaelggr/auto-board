'use client';
import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import type { HeatCell } from '@/lib/queries';

const DOW_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 周×小时热力：计数格 + 断档灰纹叠层（incomplete 格盖一层半透明灰点） */
export default function HeatmapChart({ cells }: { cells: HeatCell[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    chartRef.current ??= echarts.init(ref.current);      // 只 init 一次，数据变化走 setOption
    const chart = chartRef.current;
    const max = Math.max(1, ...cells.map((c) => c.count));
    chart.setOption({
      tooltip: { position: 'top' },
      grid: { height: '65%', top: 16 },
      xAxis: { type: 'category', data: [...Array(24).keys()], splitArea: { show: true } },
      yAxis: { type: 'category', data: DOW_LABELS, splitArea: { show: true } },
      visualMap: {
        min: 0, max, calculable: true, orient: 'horizontal',
        left: 'center', bottom: 0,
      },
      series: [
        {
          type: 'heatmap',
          data: cells.map((c) => [c.hour, c.dow, c.count]),
          itemStyle: { borderColor: '#fff', borderWidth: 1 },
        },
        {
          // 灰纹层：断档小时画半透明灰色散点（0 次触发 ≠ 未知，见三大铁律）
          type: 'scatter', symbolSize: 18, silent: false,
          itemStyle: { color: 'rgba(128,128,128,0.35)' },
          data: cells.filter((c) => c.incomplete === 1).map((c) => [c.hour, c.dow, '断档(数据未知)']),
          tooltip: { formatter: (p: any) => `${DOW_LABELS[p.value[1]]} ${p.value[0]}时：${p.value[2]}` },
        },
      ],
    });
  }, [cells]);

  useEffect(() => () => chartRef.current?.dispose(), []);  // 卸载销毁防泄漏
  return <div ref={ref} style={{ height: 380 }} />;
}
