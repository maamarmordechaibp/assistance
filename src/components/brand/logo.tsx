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
              <stop offset="0%" stopColor="#34495E" />
              <stop offset="100%" stopColor="#2C3E50" />
            </linearGradient>
          </defs>
          <rect width="64" height="64" rx="14" fill="url(#offline-grad)" />
          {/* helping hands cradling a glow */}
          <g fill="none" stroke="#FFFFFF" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" opacity="0.95">
            <path d="M16 36c0-9.5 5.5-15 13-15 3.6 0 5.5 1.8 5.5 4.5v8.5" />
            <path d="M16 36c0 7.5 5.5 11.5 11.5 11.5h5" />
            <path d="M48 36c0-9.5-5.5-15-13-15-3.6 0-5.5 1.8-5.5 4.5v8.5" />
            <path d="M48 36c0 7.5-5.5 11.5-11.5 11.5h-5" />
          </g>
          {/* terracotta spark */}
          <circle cx="32" cy="30" r="3.4" fill="#E67E22" />
          <circle cx="32" cy="30" r="6.5" fill="none" stroke="#E67E22" strokeWidth="1.5" opacity="0.6" />
        </>
      )}
      {flat && (
        <g fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 36c0-10 6-16 14-16 4 0 6 2 6 5v9" />
          <path d="M14 36c0 8 6 12 12 12h6" />
          <path d="M50 36c0-10-6-16-14-16-4 0-6 2-6 5v9" />
          <path d="M50 36c0 8-6 12-12 12h-6" />
          <circle cx="32" cy="30" r="3" fill="currentColor" stroke="none" />
        </g>
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
