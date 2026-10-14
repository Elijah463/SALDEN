'use client';
/**
 * @file components/agent/IrisBrand.tsx
 *
 * The IRIS brand mark: the avatar sits on top of the wordmark, stacked
 * vertically. Three independent animation layers, deliberately decoupled
 * from each other so each reads cleanly instead of compounding:
 *
 *   1. Ring layer (`.iris-ring-bg`), an absolutely-positioned layer BEHIND
 *      the avatar, a conic-gradient sweeping through primary and secondary
 *      colours. It spins AND hue-shifts continuously, so the glow is never
 *      just one colour moving, it's several colours moving and cycling at
 *      once ("many color glows simultaneously").
 *   2. Avatar layer (`.iris-spin`), the avatar image itself, rotating
 *      clockwise on its own slow, independent timer. It's a sibling of the
 *      ring layer (not a child), so the ring's rotation never compounds
 *      with the avatar's own spin.
 *   3. Wordmark (`.iris-wordmark`), "IRIS" in Orbitron (loaded in
 *      app/layout.tsx's Google Fonts link) with a slow colour-shimmering
 *      gradient fill.
 *
 * All three respect prefers-reduced-motion.
 */

interface IrisBrandProps {
  size?: 'sm' | 'md' | 'lg';
  showTagline?: boolean;
  showBeta?: boolean;
}

const SIZES = {
  sm: { avatar: 44,  ring: 5,  name: 16, tagline: 11, gap: 8  },
  md: { avatar: 72,  ring: 7,  name: 24, tagline: 13, gap: 10 },
  lg: { avatar: 116, ring: 10, name: 46, tagline: 16, gap: 16 },
} as const;

export function IrisBrand({ size = 'md', showTagline = false, showBeta = false }: IrisBrandProps) {
  const s = SIZES[size];
  const outer = s.avatar + s.ring * 2;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: s.gap }}>
      <div style={{ position: 'relative', width: outer, height: outer, flexShrink: 0 }}>
        {/* Ring layer: animated multi-colour glow, spins independently of the avatar */}
        <div aria-hidden className="iris-ring-bg" style={{ position: 'absolute', inset: 0, borderRadius: '50%' }} />

        {/* Static mask circle + the avatar itself, spinning on its own timer */}
        <div style={{
          position: 'absolute', top: s.ring, left: s.ring, right: s.ring, bottom: s.ring,
          borderRadius: '50%', background: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          overflow: 'hidden',
        }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/iris-avatar.png"
            alt=""
            className="iris-spin"
            style={{ width: '84%', height: '84%', objectFit: 'contain' }}
          />
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="iris-wordmark" style={{ fontSize: s.name, lineHeight: 1 }}>IRIS</span>
        {showBeta && <BetaTag />}
      </div>

      {showTagline && (
        <div style={{ fontSize: s.tagline, color: '#475569', fontWeight: 500 }}>
          Your Smart Payroll AI Agent
        </div>
      )}

      <style>{`
        .iris-wordmark {
          font-family: 'Orbitron', 'Plus Jakarta Sans', sans-serif;
          font-weight: 800;
          letter-spacing: 0.08em;
          background: linear-gradient(90deg, #4F46E5, #818CF8, #14B8A6, #4F46E5);
          background-size: 300% 100%;
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
          animation: irisShimmer 7s linear infinite;
        }
        .iris-ring-bg {
          background: conic-gradient(
            from 0deg,
            #4F46E5, #818CF8, #6366F1, #14B8A6, #34D399,
            #F59E0B, #F472B6, #EC4899, #6366F1, #4F46E5
          );
          box-shadow: 0 0 16px 2px rgba(79,70,229,0.5), 0 0 30px 8px rgba(20,184,166,0.3);
          animation: irisRingSpin 5s linear infinite, irisRingHue 9s linear infinite;
        }
        .iris-spin {
          animation: irisAvatarSpin 20s linear infinite;
        }
        @keyframes irisShimmer   { to { background-position: 300% 50%; } }
        @keyframes irisRingSpin  { to { transform: rotate(360deg); } }
        @keyframes irisRingHue   { to { filter: hue-rotate(360deg); } }
        @keyframes irisAvatarSpin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) {
          .iris-wordmark, .iris-ring-bg, .iris-spin { animation: none; }
        }
      `}</style>
    </div>
  );
}

/** Small "Beta" pill, reused anywhere the IRIS name/nav entry appears. */
export function BetaTag() {
  return (
    <span style={{
      fontSize: 10, fontWeight: 800, letterSpacing: '0.04em',
      color: '#4F46E5', background: '#EEF2FF', border: '1px solid #C7D2FE',
      borderRadius: 999, padding: '2px 7px', textTransform: 'uppercase',
      lineHeight: 1.4, flexShrink: 0,
    }}>
      Beta
    </span>
  );
}
