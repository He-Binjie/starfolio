import React, { useMemo, useRef, useState } from 'react';
import { Button, Empty, Input, Segmented, Space, Tag, Tooltip, Typography } from 'antd';
import {
  AimOutlined,
  BranchesOutlined,
  EyeOutlined,
  MinusOutlined,
  PlusOutlined,
  RobotOutlined,
  SearchOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import { StarMapCluster, StarMapNode, StarMapResponse } from '../api';

interface StarMapCanvasProps {
  data: StarMapResponse;
  onJumpToDoc: (sourceId: string, relPath: string) => void;
  onFenceDocs: (docs: Array<{ source_id: string; rel_path: string; title: string }>, label: string) => void;
  onCompareTwo?: (a: StarMapNode, b: StarMapNode) => void;
}

const PALETTE = [
  '#3b82f6',
  '#f59e0b',
  '#10b981',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#f97316',
  '#6366f1',
  '#14b8a6',
  '#ef4444',
];

const LINEAGE_COLORS: Record<'explicit' | 'version' | 'semantic', string> = {
  explicit: '#2563eb',
  version: '#d97706',
  semantic: '#10b981',
};

export const StarMapCanvas: React.FC<StarMapCanvasProps> = ({
  data,
  onJumpToDoc,
  onFenceDocs,
  onCompareTwo,
}) => {
  const [mapMode, setMapMode] = useState<'constellation' | 'lineage'>('constellation');
  const [activeClusterId, setActiveClusterId] = useState<string | null>(null);
  const [hovered, setHovered] = useState<StarMapNode | null>(null);
  const [picked, setPicked] = useState<Record<string, StarMapNode>>({});
  const [searchKw, setSearchKw] = useState('');

  // Interactive Zoom & Pan state (viewBox transform)
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const dragRef = useRef<{ active: boolean; startX: number; startY: number; origX: number; origY: number; moved: boolean }>({
    active: false,
    startX: 0,
    startY: 0,
    origX: 0,
    origY: 0,
    moved: false,
  });

  const W = 960;
  const H = 560;

  const pickedList = Object.values(picked);

  const clusterById = useMemo(() => {
    const m: Record<string, StarMapCluster> = {};
    data.clusters.forEach((c) => {
      m[c.id] = c;
    });
    return m;
  }, [data.clusters]);

  const lineageEdges = data.lineage_edges || [];
  const lineageStats = data.lineage_stats || { explicit: 0, version: 0, semantic: 0 };

  const searchMatches = useMemo(() => {
    const q = searchKw.trim().toLowerCase();
    if (!q) return new Set<number>();
    const matched = new Set<number>();
    for (const n of data.nodes) {
      if (
        n.title.toLowerCase().includes(q) ||
        n.rel_path.toLowerCase().includes(q) ||
        n.project.toLowerCase().includes(q)
      ) {
        matched.add(n.idx);
      }
    }
    return matched;
  }, [data.nodes, searchKw]);

  // Focus node for lineage upstream/downstream spotlight
  const focusNode = hovered || (pickedList.length === 1 ? pickedList[0] : null);
  const pinnedNode = pickedList.length === 1 ? pickedList[0] : null;

  const focusLineage = useMemo(() => {
    const upstreamNodes: Array<{ node: StarMapNode; label: string; type: 'explicit' | 'version' | 'semantic' }> = [];
    const downstreamNodes: Array<{ node: StarMapNode; label: string; type: 'explicit' | 'version' | 'semantic' }> = [];
    const upstreamSet = new Set<number>();
    const downstreamSet = new Set<number>();
    if (focusNode) {
      for (const e of lineageEdges) {
        if (e.to === focusNode.idx && !upstreamSet.has(e.from)) {
          upstreamSet.add(e.from);
          if (data.nodes[e.from]) {
            upstreamNodes.push({ node: data.nodes[e.from], label: e.label, type: e.type });
          }
        }
        if (e.from === focusNode.idx && !downstreamSet.has(e.to)) {
          downstreamSet.add(e.to);
          if (data.nodes[e.to]) {
            downstreamNodes.push({ node: data.nodes[e.to], label: e.label, type: e.type });
          }
        }
      }
    }
    return { upstreamSet, downstreamSet, upstreamNodes, downstreamNodes };
  }, [focusNode, lineageEdges, data.nodes]);

  if (!data || data.nodes.length === 0) {
    return <Empty description="暂无足够向量生成星海星图" />;
  }

  const togglePick = (node: StarMapNode) => {
    if (dragRef.current.moved) return;
    const key = `${node.source_id}::${node.rel_path}`;
    setPicked((prev) => {
      const next = { ...prev };
      if (next[key]) delete next[key];
      else if (Object.keys(next).length < 8) next[key] = node;
      return next;
    });
  };

  const focusAndCenterNode = (node: StarMapNode) => {
    const key = `${node.source_id}::${node.rel_path}`;
    setPicked({ [key]: node });
    const targetZoom = Math.max(zoom, 1.8);
    setZoom(targetZoom);
    setPan({
      x: W / 2 - node.x * W * targetZoom,
      y: H / 2 - node.y * H * targetZoom,
    });
  };

  const handleWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 0.87;
    setZoom((prev) => {
      const next = Math.min(3.8, Math.max(0.75, +(prev * factor).toFixed(2)));
      // Keep canvas center steady on zoom
      const ratio = next / prev;
      setPan((p) => ({
        x: W / 2 - (W / 2 - p.x) * ratio,
        y: H / 2 - (H / 2 - p.y) * ratio,
      }));
      return next;
    });
  };

  const handleMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    dragRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      origX: pan.x,
      origY: pan.y,
      moved: false,
    };
  };

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!dragRef.current.active) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = W / Math.max(1, rect.width);
    const scaleY = H / Math.max(1, rect.height);
    const dx = (e.clientX - dragRef.current.startX) * scaleX;
    const dy = (e.clientY - dragRef.current.startY) * scaleY;
    if (Math.hypot(dx, dy) > 4) dragRef.current.moved = true;
    setPan({ x: dragRef.current.origX + dx, y: dragRef.current.origY + dy });
  };

  const handleMouseUp = () => {
    dragRef.current.active = false;
    setTimeout(() => {
      dragRef.current.moved = false;
    }, 30);
  };

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const adjustZoom = (delta: number) => {
    setZoom((prev) => {
      const next = Math.min(3.8, Math.max(0.75, +(prev + delta).toFixed(2)));
      const ratio = next / prev;
      setPan((p) => ({
        x: W / 2 - (W / 2 - p.x) * ratio,
        y: H / 2 - (H / 2 - p.y) * ratio,
      }));
      return next;
    });
  };

  const hasSearch = searchKw.trim().length > 0;

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto' }}>
      {/* Top cluster legend filter bar */}
      <div className="section-card" style={{ padding: '12px 16px', marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          <div>
            <Typography.Text strong style={{ fontSize: 14 }}>
              星海星图 · {mapMode === 'lineage' ? '文档血缘流向' : '2D 语义星座'}（0 Token · 展示 {data.total_docs} 颗文档星点）
            </Typography.Text>
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>
              {mapMode === 'lineage'
                ? '箭头指向「上游来源 → 下游衍生」。支持滚轮缩放与拖拽平移；单击任意星点展开右侧血缘浮窗直达上下游。'
                : '位置越近代表文档语义越相近。支持滚轮缩放、拖拽平移与右上角搜星定位；单击选中，双击直达原文。'}
            </div>
          </div>
          <Space size={8} wrap>
            <Input
              size="small"
              allowClear
              style={{ width: 185 }}
              placeholder="在星图中定位文档…"
              prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
              value={searchKw}
              onChange={(e) => setSearchKw(e.target.value)}
              onPressEnter={() => {
                const firstIdx = Array.from(searchMatches)[0];
                if (firstIdx !== undefined && data.nodes[firstIdx]) {
                  focusAndCenterNode(data.nodes[firstIdx]);
                }
              }}
            />
            {hasSearch && (
              <Tag color={searchMatches.size > 0 ? 'gold' : 'default'} style={{ margin: 0 }}>
                命中 {searchMatches.size} 颗
              </Tag>
            )}
            <Segmented
              size="small"
              value={mapMode}
              onChange={(v) => setMapMode(v as 'constellation' | 'lineage')}
              options={[
                { label: '语义星座', value: 'constellation' },
                { label: `血缘流向 (${lineageEdges.length})`, value: 'lineage' },
              ]}
            />
            {activeClusterId && clusterById[activeClusterId] && (
              <Button
                size="small"
                type="primary"
                icon={<RobotOutlined />}
                onClick={() => {
                  const c = clusterById[activeClusterId];
                  onFenceDocs(
                    c.docs.slice(0, 6).map((d) => ({ source_id: d.source_id, rel_path: d.rel_path, title: d.title })),
                    c.title
                  );
                }}
              >
                将该星座拉入 AI 对比
              </Button>
            )}
          </Space>
        </div>

        {mapMode === 'lineage' && (
          <div className="starmap-lineage-legend">
            <span className="lineage-legend-item">
              <span className="lineage-swatch" style={{ background: LINEAGE_COLORS.explicit }} />
              显式引用 ({lineageStats.explicit})
            </span>
            <span className="lineage-legend-item">
              <span className="lineage-swatch" style={{ background: LINEAGE_COLORS.version }} />
              版本演进 ({lineageStats.version})
            </span>
            <span className="lineage-legend-item">
              <span className="lineage-swatch is-dashed" style={{ borderColor: LINEAGE_COLORS.semantic }} />
              阶段语义上下游 ({lineageStats.semantic})
            </span>
            {focusNode && (
              <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--text-secondary)' }}>
                当前聚焦：{focusNode.title.slice(0, 22)}（上游 {focusLineage.upstreamSet.size} · 下游 {focusLineage.downstreamSet.size}）
              </span>
            )}
          </div>
        )}

        <Space size={6} wrap>
          <Tag
            color={activeClusterId === null ? 'blue' : 'default'}
            style={{ cursor: 'pointer', margin: 0 }}
            onClick={() => setActiveClusterId(null)}
          >
            全部星座 ({data.clusters.length})
          </Tag>
          {data.clusters.map((c) => {
            const col = PALETTE[c.color_idx % PALETTE.length];
            const isAct = activeClusterId === c.id;
            return (
              <Tag
                key={c.id}
                style={{
                  cursor: 'pointer',
                  margin: 0,
                  borderColor: isAct ? col : undefined,
                  fontWeight: isAct ? 600 : 400,
                }}
                onClick={() => setActiveClusterId(isAct ? null : c.id)}
              >
                <span
                  style={{
                    display: 'inline-block',
                    width: 8,
                    height: 8,
                    borderRadius: 99,
                    background: col,
                    marginRight: 5,
                  }}
                />
                {c.title} ({c.shown_count})
              </Tag>
            );
          })}
        </Space>
      </div>

      {/* Interactive Celestial SVG with Zoom & Pan */}
      <div className="starmap-frame">
        {/* Floating Zoom/Pan Controls */}
        <div className="starmap-zoom-controls">
          <Tooltip title="放大">
            <Button size="small" type="text" icon={<PlusOutlined />} onClick={() => adjustZoom(0.35)} />
          </Tooltip>
          <span className="starmap-zoom-pct">{Math.round(zoom * 100)}%</span>
          <Tooltip title="缩小">
            <Button size="small" type="text" icon={<MinusOutlined />} onClick={() => adjustZoom(-0.35)} />
          </Tooltip>
          <Tooltip title="复位视角">
            <Button size="small" type="text" icon={<AimOutlined />} onClick={resetView} />
          </Tooltip>
        </div>

        {/* Floating Lineage Chain Inspector when a single star is pinned in Lineage mode */}
        {mapMode === 'lineage' && pinnedNode && (focusLineage.upstreamNodes.length > 0 || focusLineage.downstreamNodes.length > 0) && (
          <div className="starmap-lineage-drawer">
            <div className="starmap-lineage-drawer-head">
              <Space size={5}>
                <BranchesOutlined style={{ color: 'var(--accent)' }} />
                <span>星点血缘追踪</span>
              </Space>
              <Button size="small" type="link" style={{ padding: 0, height: 'auto' }} onClick={() => onJumpToDoc(pinnedNode.source_id, pinnedNode.rel_path)}>
                读本篇 →
              </Button>
            </div>
            <div className="starmap-lineage-drawer-cur">{pinnedNode.title}</div>
            {focusLineage.upstreamNodes.length > 0 && (
              <div className="starmap-lineage-group">
                <div className="starmap-lineage-group-title">▲ 上游依据 ({focusLineage.upstreamNodes.length})</div>
                {focusLineage.upstreamNodes.slice(0, 5).map(({ node, label }) => (
                  <div
                    key={`u-${node.idx}`}
                    className="starmap-lineage-row"
                    onClick={() => focusAndCenterNode(node)}
                    onDoubleClick={() => onJumpToDoc(node.source_id, node.rel_path)}
                  >
                    <span className="starmap-lineage-row-t">{node.title}</span>
                    <span className="starmap-lineage-row-m">{label}</span>
                  </div>
                ))}
              </div>
            )}
            {focusLineage.downstreamNodes.length > 0 && (
              <div className="starmap-lineage-group">
                <div className="starmap-lineage-group-title">▼ 下游衍生 ({focusLineage.downstreamNodes.length})</div>
                {focusLineage.downstreamNodes.slice(0, 5).map(({ node, label }) => (
                  <div
                    key={`d-${node.idx}`}
                    className="starmap-lineage-row"
                    onClick={() => focusAndCenterNode(node)}
                    onDoubleClick={() => onJumpToDoc(node.source_id, node.rel_path)}
                  >
                    <span className="starmap-lineage-row-t">{node.title}</span>
                    <span className="starmap-lineage-row-m">{label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="starmap-svg"
          style={{ cursor: dragRef.current.active ? 'grabbing' : 'grab', userSelect: 'none' }}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          <defs>
            {(['explicit', 'version', 'semantic'] as const).map((t) => (
              <marker
                key={t}
                id={`arr-${t}`}
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="5.5"
                markerHeight="5.5"
                orient="auto-start-reverse"
              >
                <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill={LINEAGE_COLORS[t]} />
              </marker>
            ))}
          </defs>

          <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
            {/* Subtle coordinate grid circles */}
            <circle cx={W / 2} cy={H / 2} r={140} fill="none" stroke="currentColor" strokeOpacity="0.06" strokeDasharray="3 5" />
            <circle cx={W / 2} cy={H / 2} r={260} fill="none" stroke="currentColor" strokeOpacity="0.05" strokeDasharray="3 5" />

            {/* Soft cluster nebulae (background layer) */}
            {data.clusters.map((c) => {
              const col = PALETTE[c.color_idx % PALETTE.length];
              const dimmed =
                (activeClusterId !== null && activeClusterId !== c.id) ||
                (mapMode === 'lineage' && focusNode !== null) ||
                hasSearch;
              return (
                <circle
                  key={`halo-${c.id}`}
                  cx={c.cx * W}
                  cy={c.cy * H}
                  r={56}
                  fill={col}
                  fillOpacity={dimmed ? 0.02 : 0.08}
                />
              );
            })}

            {/* Constellation edges */}
            {data.edges.map((e, i) => {
              const a = data.nodes[e.a];
              const b = data.nodes[e.b];
              if (!a || !b) return null;
              const col = PALETTE[a.color_idx % PALETTE.length];
              const dimmed = activeClusterId !== null && activeClusterId !== e.cluster_id;
              const op = mapMode === 'lineage' || hasSearch ? 0.05 : dimmed ? 0.08 : 0.34;
              return (
                <line
                  key={i}
                  x1={a.x * W}
                  y1={a.y * H}
                  x2={b.x * W}
                  y2={b.y * H}
                  stroke={col}
                  strokeWidth={(dimmed ? 0.6 : 1.15) / Math.sqrt(zoom)}
                  strokeOpacity={op}
                />
              );
            })}

            {/* Directed Lineage Edges (in lineage mode) */}
            {mapMode === 'lineage' &&
              lineageEdges.map((e, i) => {
                const src = data.nodes[e.from];
                const dst = data.nodes[e.to];
                if (!src || !dst) return null;
                const x1 = src.x * W;
                const y1 = src.y * H;
                const x2 = dst.x * W;
                const y2 = dst.y * H;
                const dx = x2 - x1;
                const dy = y2 - y1;
                const dist = Math.hypot(dx, dy);
                if (dist < 10) return null;
                const padStart = 7 / Math.sqrt(zoom);
                const padEnd = 10 / Math.sqrt(zoom);
                const sx = x1 + (dx / dist) * padStart;
                const sy = y1 + (dy / dist) * padStart;
                const tx = x2 - (dx / dist) * padEnd;
                const ty = y2 - (dy / dist) * padEnd;

                const clusterDimmed =
                  activeClusterId !== null &&
                  src.cluster_id !== activeClusterId &&
                  dst.cluster_id !== activeClusterId;

                const isFocusEdge =
                  focusNode !== null && (e.from === focusNode.idx || e.to === focusNode.idx);

                let opacity = e.type === 'semantic' ? 0.42 : 0.68;
                let strokeWidth = (e.type === 'semantic' ? 1.15 : 1.55) / Math.sqrt(zoom);
                if (focusNode !== null) {
                  if (isFocusEdge) {
                    opacity = 0.96;
                    strokeWidth = 2.2 / Math.sqrt(zoom);
                  } else {
                    opacity = 0.07;
                    strokeWidth = 0.8 / Math.sqrt(zoom);
                  }
                } else if (clusterDimmed) {
                  opacity = 0.08;
                }

                return (
                  <line
                    key={`lin-${i}`}
                    x1={sx}
                    y1={sy}
                    x2={tx}
                    y2={ty}
                    stroke={LINEAGE_COLORS[e.type]}
                    strokeWidth={strokeWidth}
                    strokeOpacity={opacity}
                    strokeDasharray={e.type === 'semantic' ? '4 3' : undefined}
                    markerEnd={`url(#arr-${e.type})`}
                  />
                );
              })}

            {/* Star nodes */}
            {data.nodes.map((node) => {
              const key = `${node.source_id}::${node.rel_path}`;
              const col = PALETTE[node.color_idx % PALETTE.length];
              const isPicked = Boolean(picked[key]);
              const isHovered = hovered?.idx === node.idx;
              const isMatched = hasSearch && searchMatches.has(node.idx);
              const isUpstream = mapMode === 'lineage' && focusLineage.upstreamSet.has(node.idx);
              const isDownstream = mapMode === 'lineage' && focusLineage.downstreamSet.has(node.idx);
              const isFocusRelated =
                focusNode !== null && (node.idx === focusNode.idx || isUpstream || isDownstream);

              let dimmed = activeClusterId !== null && activeClusterId !== node.cluster_id && !isPicked;
              if (hasSearch) {
                dimmed = !isMatched && !isPicked;
              } else if (mapMode === 'lineage' && focusNode !== null) {
                dimmed = !isFocusRelated && !isPicked;
              }
              const baseR =
                isPicked || isHovered || isMatched
                  ? 7.5
                  : isUpstream || isDownstream
                    ? 6.6
                    : 4.6 + Math.min(2, node.centrality * 2);
              const r = baseR / Math.sqrt(zoom);

              return (
                <g
                  key={key}
                  style={{ cursor: 'pointer' }}
                  opacity={dimmed ? 0.14 : 1}
                  onMouseEnter={() => setHovered(node)}
                  onMouseLeave={() => setHovered((cur) => (cur?.idx === node.idx ? null : cur))}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    togglePick(node);
                  }}
                  onDoubleClick={(ev) => {
                    ev.stopPropagation();
                    onJumpToDoc(node.source_id, node.rel_path);
                  }}
                >
                  {(isPicked || isHovered) && (
                    <circle cx={node.x * W} cy={node.y * H} r={r + 4.5 / Math.sqrt(zoom)} fill="none" stroke="#3b82f6" strokeWidth={2.2 / Math.sqrt(zoom)} />
                  )}
                  {isMatched && (
                    <circle cx={node.x * W} cy={node.y * H} r={r + 6 / Math.sqrt(zoom)} fill="none" stroke="#f59e0b" strokeWidth={2.4 / Math.sqrt(zoom)} />
                  )}
                  {isUpstream && (
                    <circle cx={node.x * W} cy={node.y * H} r={r + 4.5 / Math.sqrt(zoom)} fill="none" stroke="#f59e0b" strokeWidth={2.2 / Math.sqrt(zoom)} />
                  )}
                  {isDownstream && (
                    <circle cx={node.x * W} cy={node.y * H} r={r + 4.5 / Math.sqrt(zoom)} fill="none" stroke="#10b981" strokeWidth={2.2 / Math.sqrt(zoom)} />
                  )}
                  <circle cx={node.x * W} cy={node.y * H} r={r} fill={col} stroke="#ffffff" strokeWidth={1.1 / Math.sqrt(zoom)} />
                </g>
              );
            })}

            {/* Foreground legible cluster labels (always above dots!) */}
            {data.clusters.map((c) => {
              const col = PALETTE[c.color_idx % PALETTE.length];
              const dimmed =
                (activeClusterId !== null && activeClusterId !== c.id) ||
                (mapMode === 'lineage' && focusNode !== null) ||
                hasSearch;
              return (
                <text
                  key={`lbl-${c.id}`}
                  x={c.cx * W}
                  y={Math.max(22, c.cy * H - 16 / Math.sqrt(zoom))}
                  textAnchor="middle"
                  className="starmap-cluster-label"
                  style={{ fontSize: `${11.5 / Math.sqrt(zoom)}px` }}
                  fill={col}
                  opacity={dimmed ? 0.14 : 0.96}
                >
                  {c.title}
                </text>
              );
            })}
          </g>
        </svg>

        {/* Floating hover info bar */}
        {hovered && (
          <div className="starmap-hover-bar">
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>
                {hovered.title}{' '}
                <Tag bordered={false} style={{ marginLeft: 4 }}>
                  {hovered.ext}
                </Tag>
                {hovered.stage_label && (
                  <Tag bordered={false} color="blue" style={{ marginLeft: 2 }}>
                    {hovered.stage_label}
                  </Tag>
                )}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                {hovered.source_name} / {hovered.rel_path} · 所属星座：{clusterById[hovered.cluster_id]?.title || '-'}
                {mapMode === 'lineage' &&
                  ` · 血缘：上游 ${focusLineage.upstreamSet.size} / 下游 ${focusLineage.downstreamSet.size}`}
              </div>
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>
              单击选中追踪 · 双击读原文
            </Typography.Text>
          </div>
        )}
      </div>

      {/* Selected Stars Action Bar */}
      {pickedList.length > 0 && (
        <div className="section-card" style={{ marginTop: 12, padding: '10px 14px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <Space size={6} wrap>
              <Typography.Text strong style={{ fontSize: 12.5 }}>
                已摘取 {pickedList.length} 颗文档星点：
              </Typography.Text>
              {pickedList.map((n) => (
                <Tag
                  key={`${n.source_id}::${n.rel_path}`}
                  closable
                  onClose={() => togglePick(n)}
                  style={{ margin: 0 }}
                >
                  {n.title.slice(0, 18)}
                </Tag>
              ))}
            </Space>
            <Space size={6}>
              {pickedList.length === 1 && (
                <Button
                  size="small"
                  icon={<EyeOutlined />}
                  onClick={() => onJumpToDoc(pickedList[0].source_id, pickedList[0].rel_path)}
                >
                  打开原文
                </Button>
              )}
              {pickedList.length === 2 && onCompareTwo && (
                <Button
                  size="small"
                  icon={<SwapOutlined />}
                  onClick={() => onCompareTwo(pickedList[0], pickedList[1])}
                >
                  双栏并排对照
                </Button>
              )}
              <Button
                size="small"
                type="primary"
                icon={<RobotOutlined />}
                onClick={() =>
                  onFenceDocs(
                    pickedList.map((n) => ({ source_id: n.source_id, rel_path: n.rel_path, title: n.title })),
                    '星海星图摘取'
                  )
                }
              >
                拉入 AI 围栏分析
              </Button>
              <Button size="small" type="text" onClick={() => setPicked({})}>
                清空
              </Button>
            </Space>
          </div>
        </div>
      )}
    </div>
  );
};
