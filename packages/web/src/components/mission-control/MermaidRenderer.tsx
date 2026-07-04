'use client';

/**
 * MermaidRenderer — Next.js client-safe component to render Mermaid diagrams
 * with custom dark mode and premium aesthetics.
 */

import { useEffect, useRef, useState } from 'react';

interface MermaidRendererProps {
  chart: string;
}

export function MermaidRenderer({ chart }: MermaidRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svgContent, setSvgContent] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function renderDiagram() {
      if (typeof window === 'undefined') return;

      try {
        // Dynamic client-side import of mermaid to avoid SSR issues
        const { default: mermaid } = await import('mermaid');

        mermaid.initialize({
          startOnLoad: false,
          theme: 'dark',
          securityLevel: 'loose',
          flowchart: {
            useMaxWidth: true,
            htmlLabels: true,
            curve: 'basis',
          },
        });

        const elementId = `mermaid-svg-${Math.random().toString(36).substring(7)}`;
        const { svg } = await mermaid.render(elementId, chart);

        if (active) {
          setSvgContent(svg);
          setError(null);
        }
      } catch (err: unknown) {
        console.error('Mermaid render error:', err);
        if (active) {
          setError(err instanceof Error ? err.message : '渲染拓扑图失败');
        }
      }
    }

    void renderDiagram();

    return () => {
      active = false;
    };
  }, [chart]);

  return (
    <div
      className="relative overflow-hidden rounded-[14px] backdrop-blur-md px-4 py-4 transition-all duration-300"
      style={{
        border: '1px solid var(--console-border, rgba(255, 255, 255, 0.08))',
        backgroundColor: 'var(--console-shell-bg, rgba(10, 13, 20, 0.4))',
      }}
    >
      <div
        className="mb-2 flex items-center justify-between pb-2"
        style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.04)' }}
      >
        <span className="text-micro font-semibold uppercase tracking-wider text-cafe-secondary">
          P2P Link Graph 实时决策拓扑
        </span>
        <span
          className="flex h-2 w-2 rounded-full animate-pulse"
          style={{ backgroundColor: '#10b981' }} // emerald-500 equivalent inline
          title="Live Synced via WebRTC"
        />
      </div>

      {error ? (
        <p className="text-xs text-[var(--semantic-error-text,#e74c3c)]">{error}</p>
      ) : svgContent ? (
        <div
          ref={containerRef}
          className="flex justify-center max-w-full overflow-x-auto select-none [&>svg]:h-auto [&>svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: svgContent }}
        />
      ) : (
        <div className="flex h-32 items-center justify-center">
          <p className="text-xs text-cafe-muted animate-pulse">正在生成脑图...</p>
        </div>
      )}
    </div>
  );
}
