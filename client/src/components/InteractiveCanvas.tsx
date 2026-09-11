import React, { useEffect, useRef } from 'react';

export interface InteractiveCanvasProps {
  gridWidth?: number;
  gridHeight?: number;
  dotColor?: string;
  lineColor?: string;
  backgroundColor?: string;
  padding?: number;
  maxDistance?: number;
  dotSizeMultiplier?: number;
  className?: string;
  style?: React.CSSProperties;
}

export function InteractiveCanvas({
  gridWidth = 120,
  gridHeight = 120,
  dotColor = '#0000ff',
  lineColor = '#5555550',
  backgroundColor = 'transparent', // default to transparent
  padding = 0,
  maxDistance = 2,
  dotSizeMultiplier = 200,
  className = 'fixed inset-0 w-screen h-screen',
  style,
}: InteractiveCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouseRef = useRef({ x: -9999, y: -9999 });
  const dotsRef = useRef<
    Array<{ x: number; y: number; ox: number; oy: number; size?: number; angle?: number }>
  >([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { alpha: true }); // enable transparency
    if (!ctx) return;

    const ratio = window.devicePixelRatio || 1;

    const createDots = () => {
      dotsRef.current = [];
      const canvasWidth = canvas.width / ratio;
      const canvasHeight = canvas.height / ratio;

      for (let i = 0; i < gridWidth; i++) {
        const x = Math.floor(((canvasWidth - padding * 2) / Math.max(gridWidth - 1, 1)) * i + padding);

        for (let j = 0; j < gridHeight; j++) {
          const y = Math.floor(((canvasHeight - padding * 2) / Math.max(gridHeight - 1, 1)) * j + padding);

          dotsRef.current.push({
            x: x * ratio,
            y: y * ratio,
            ox: x * ratio,
            oy: y * ratio,
          });
        }
      }
    };

    const handleResize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = (rect.width || window.innerWidth) * ratio;
      canvas.height = (rect.height || window.innerHeight) * ratio;
      ctx.scale(ratio, ratio);
      createDots();
    };

    handleResize();
    window.addEventListener('resize', handleResize);

    const handleMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouseRef.current.x = (e.clientX - rect.left) * ratio;
      mouseRef.current.y = (e.clientY - rect.top) * ratio;
    };

    window.addEventListener('mousemove', handleMouseMove);

    const getDistance = (obj1: { x: number; y: number }, obj2: { x: number; y: number }) => {
      const dx = obj1.x - obj2.x;
      const dy = obj1.y - obj2.y;
      return Math.sqrt(dx * dx + dy * dy);
    };

    const getAngle = (obj1: { x: number; y: number }, obj2: { x: number; y: number }) => {
      const dX = obj2.x - obj1.x;
      const dY = obj2.y - obj1.y;
      return (Math.atan2(dY, dX) / Math.PI) * 180;
    };

    const getVector = (dot: (typeof dotsRef.current)[0]) => {
      const d = getDistance(dot, mouseRef.current);
      dot.size = (dotSizeMultiplier - d) / 20;
      dot.size = dot.size < 1 ? 1 : dot.size;
      dot.angle = getAngle(dot, mouseRef.current);

      const distance = d > maxDistance ? maxDistance : d;
      return {
        x: distance * Math.cos((dot.angle * Math.PI) / 180),
        y: distance * Math.sin((dot.angle * Math.PI) / 180),
      };
    };

    const circleMethod = function (this: CanvasRenderingContext2D, x: number, y: number, r: number) {
      this.beginPath();
      this.arc(x, y, r, 0, 2 * Math.PI, false);
      this.closePath();
    };
    (ctx as any).circle = circleMethod;

    let animId: number;

    const animate = () => {
      // Transparent background handling
      if (backgroundColor && backgroundColor !== 'transparent') {
        ctx.fillStyle = backgroundColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }

      ctx.fillStyle = dotColor;

      // Draw lines
      const activeLineColor = lineColor === '#5555550' ? '#55555500' : lineColor;
      if (activeLineColor && activeLineColor !== 'transparent' && activeLineColor !== '#55555500') {
        ctx.strokeStyle = activeLineColor;
        ctx.lineWidth = 1;
        for (let i = 0; i < dotsRef.current.length; i++) {
          const dot = dotsRef.current[i];
          const v = getVector(dot);

          ctx.beginPath();
          ctx.moveTo(dot.x / ratio, dot.y / ratio);
          ctx.lineTo((dot.x + v.x) / ratio, (dot.y + v.y) / ratio);
          ctx.stroke();
          ctx.closePath();
        }
      }

      // Draw dots
      const totalH = canvas.height;
      for (let i = 0; i < dotsRef.current.length; i++) {
        const dot = dotsRef.current[i];
        const v = getVector(dot);
        const yFrac = dot.y / totalH;
        let alpha = 1;
        if (yFrac > 0.88) {
          alpha = Math.max(0, 1 - (yFrac - 0.88) / 0.12);
        }
        if (alpha <= 0.01) continue;

        ctx.globalAlpha = alpha;
        (ctx as any).circle((dot.x + v.x) / ratio, (dot.y + v.y) / ratio, (dot.size || 1) / 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1.0;

      animId = requestAnimationFrame(animate);
    };

    animate();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('mousemove', handleMouseMove);
    };
  }, [gridWidth, gridHeight, dotColor, lineColor, backgroundColor, padding, maxDistance, dotSizeMultiplier]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{
        display: 'block',
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        margin: 0,
        overflow: 'hidden',
        background: 'transparent', // ensure CSS transparency
        pointerEvents: 'none',
        ...style,
      }}
    />
  );
}

export default InteractiveCanvas;
