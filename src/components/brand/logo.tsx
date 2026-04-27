import { cn } from '@/lib/utils';

interface LogoProps {
  className?: string;
  size?: number;
  variant?: 'mark' | 'wordmark' | 'full';
  /** When true, mark renders without a colored tile (transparent bg). */
  flat?: boolean;
}

/**
 * Offline brand mark — concentric signal.
 * - `mark`     : just the icon
 * - `wordmark` : just the text
 * - `full`     : mark + text side by side (default)
 */
export function Logo({ className, size = 28, variant = 'full', flat = false }: LogoProps) {
  const Mark = (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="Offline"
      className="shrink-0"
    >
      {!flat && (
        <>
          <defs>
            <linearGradient id="offline-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#3b82f6" />
              <stop offset="100%" stopColor="#1e3a8a" />
            </linearGradient>
          </defs>
          <rect width="64" height="64" rx="14" fill="url(#offline-grad)" />
          <circle cx="32" cy="32" r="18" fill="none" stroke="#fff" strokeWidth="3.5" opacity="0.95" />
          <circle cx="32" cy="32" r="9" fill="none" stroke="#fff" strokeWidth="3.5" opacity="0.65" />
          <circle cx="32" cy="32" r="2.6" fill="#fff" />
        </>
      )}
      {flat && (
        <>
          <circle cx="32" cy="32" r="22" fill="none" stroke="currentColor" strokeWidth="4" />
          <circle cx="32" cy="32" r="11" fill="none" stroke="currentColor" strokeWidth="4" opacity="0.6" />
          <circle cx="32" cy="32" r="3.2" fill="currentColor" />
        </>
      )}
    </svg>
  );

  if (variant === 'mark') return <span className={className}>{Mark}</span>;

  const wordmark = (
    <span className="font-semibold tracking-tight leading-none">
      Offline
    </span>
  );

  if (variant === 'wordmark') return <span className={className}>{wordmark}</span>;

  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      {Mark}
      {wordmark}
    </span>
  );
}
