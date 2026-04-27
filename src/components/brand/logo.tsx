import { cn } from '@/lib/utils';
import markSrc from './OfflineLogoMark.svg';
import horizontalSrc from './OfflineLogoHorizontal.svg';
import whiteSrc from './OfflineLogoWhite.svg';

interface LogoProps {
  className?: string;
  /** Pixel height for sizing. Width auto-scales to native aspect ratio. */
  size?: number;
  variant?: 'mark' | 'wordmark' | 'full' | 'white';
  /** Legacy prop, kept for backward compat. */
  flat?: boolean;
}

/**
 * Offline brand mark — Helping Hands lockup.
 * - `mark`      : badge icon only (orange gradient tile)
 * - `wordmark`  : "Offline" text only
 * - `full`      : horizontal lockup (badge + OFFLINE + tagline)
 * - `white`     : white-on-transparent lockup for dark sidebars
 */
export function Logo({ className, size = 28, variant = 'full' }: LogoProps) {
  if (variant === 'wordmark') {
    return (
      <span
        className={cn(
          'font-semibold tracking-tight leading-none text-foreground',
          className,
        )}
      >
        Offline
      </span>
    );
  }

  const asset =
    variant === 'full' ? horizontalSrc : variant === 'white' ? whiteSrc : markSrc;
  // StaticImageData has .src; raw string fallback for ?url imports.
  const src = typeof asset === 'string' ? asset : (asset as { src: string }).src;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt="Offline"
      className={cn('shrink-0 select-none', className)}
      style={{ height: size, width: 'auto' }}
      draggable={false}
    />
  );
}
