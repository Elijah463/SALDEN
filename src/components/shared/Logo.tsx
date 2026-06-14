/**
 * @file components/shared/Logo.tsx
 * Salden brand logo — renders the real /logo.svg mark + SALDEN wordmark.
 * Uses a standard <img> tag so SVG renders at full fidelity on all browsers.
 */

interface LogoProps {
  size?: number;
  textColor?: string;
  showText?: boolean;
  variant?: 'default' | 'white';
}

export function SaldenLogo({
  size = 32,
  textColor,
  showText = true,
  variant = 'default',
}: LogoProps) {
  const resolvedTextColor = textColor ?? (variant === 'white' ? '#fff' : '#4F46E5');

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, userSelect: 'none' }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/logo.svg"
        alt="Salden"
        width={size}
        height={size}
        style={{ objectFit: 'contain', display: 'block' }}
      />
      {showText && (
        <span
          style={{
            fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
            fontSize:   size * 0.6,
            fontWeight: 800,
            letterSpacing: '0.08em',
            color: resolvedTextColor,
            lineHeight: 1,
          }}
        >
          SALDEN
        </span>
      )}
    </div>
  );
}

export function SaldenLogoWhite({ size = 32, showText = true }: { size?: number; showText?: boolean }) {
  return <SaldenLogo size={size} showText={showText} variant="white" />;
}
