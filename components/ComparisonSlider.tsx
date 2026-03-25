import React, { useState, useRef, useEffect } from 'react';

interface ComparisonSliderProps {
  beforeImage: string;
  afterImage: string;
  beforeLabel?: string;
  afterLabel?: string;
}

export const ComparisonSlider: React.FC<ComparisonSliderProps> = ({
  beforeImage,
  afterImage,
  beforeLabel = 'Original',
  afterLabel = 'WebP'
}) => {
  const [sliderPosition, setSliderPosition] = useState(50);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMove = (clientX: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    setSliderPosition((x / rect.width) * 100);
  };

  const onMouseMove = (e: MouseEvent) => {
    if (isDragging) handleMove(e.clientX);
  };

  const onMouseUp = () => {
    setIsDragging(false);
  };

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    } else {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [isDragging]);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full select-none cursor-ew-resize overflow-hidden bg-black/5 rounded-lg"
      onMouseDown={(e) => {
        setIsDragging(true);
        handleMove(e.clientX);
      }}
    >
      <img src={afterImage} alt={afterLabel} className="absolute inset-0 w-full h-full object-contain pointer-events-none" />
      <img
        src={beforeImage}
        alt={beforeLabel}
        className="absolute inset-0 w-full h-full object-contain pointer-events-none"
        style={{ clipPath: `inset(0 ${100 - sliderPosition}% 0 0)` }}
      />
      <div
        className="absolute top-0 bottom-0 w-0.5 bg-white mix-blend-difference pointer-events-none shadow-[0_0_4px_rgba(0,0,0,0.5)] flex items-center justify-center z-10"
        style={{ left: `${sliderPosition}%` }}
      >
        <div className="w-8 h-8 -ml-4 rounded-full bg-white flex items-center justify-center shadow-lg text-slate-800 pointer-events-auto cursor-ew-resize">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l6-6-6-6M9 18l-6-6 6-6" /></svg>
        </div>
      </div>

      <div className="absolute top-3 left-3 bg-black/60 text-white text-xs px-2 py-1 rounded backdrop-blur-sm shadow pointer-events-none z-20">
        {beforeLabel}
      </div>
      <div className="absolute top-3 right-3 bg-black/60 text-white text-xs px-2 py-1 rounded backdrop-blur-sm shadow pointer-events-none z-20">
        {afterLabel}
      </div>
    </div>
  );
};
