import { useEffect, useRef, useState, type UIEvent } from 'react';

interface VirtualWindowOptions {
  count: number;
  itemHeight: number;
  overscan?: number;
}

export function useVirtualWindow({
  count,
  itemHeight,
  overscan = 6,
}: VirtualWindowOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const element = containerRef.current;

    if (!element) {
      return;
    }

    const updateHeight = () => {
      setHeight(element.clientHeight);
    };

    updateHeight();

    const resizeObserver = new ResizeObserver(updateHeight);
    resizeObserver.observe(element);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const visibleCount = Math.ceil(height / itemHeight) + overscan * 2;
  const endIndex = Math.min(count, startIndex + visibleCount);
  const beforeHeight = startIndex * itemHeight;
  const afterHeight = Math.max(0, count * itemHeight - endIndex * itemHeight);

  return {
    containerRef,
    startIndex,
    endIndex,
    beforeHeight,
    afterHeight,
    onScroll: (event: UIEvent<HTMLDivElement>) => {
      setScrollTop(event.currentTarget.scrollTop);
    },
  };
}
