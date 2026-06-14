/**
 * @file components/shared/Illustrations.tsx
 *
 * Premium SVG illustrations — layered depth, rich gradients, drop shadows.
 * Brand palette: #4F46E5 (Deep Indigo) · #14B8A6 (Teal) · #6D28D9 (Purple) · #EEF2FF (Indigo-50)
 * No external dependencies — pure SVG shipped as zero runtime bytes.
 */

interface IllustrationProps {
  className?: string;
  width?:     number | string;
  height?:    number | string;
}

// ── Shared defs injected once per illustration ────────────────────────────────
function Defs({ id }: { id: string }) {
  return (
    <defs>
      {/* Shadows */}
      <filter id={`${id}-shadow-lg`} x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="8"  stdDeviation="16" floodColor="#4F46E5" floodOpacity="0.18" />
      </filter>
      <filter id={`${id}-shadow-md`} x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="4"  stdDeviation="8"  floodColor="#4F46E5" floodOpacity="0.12" />
      </filter>
      <filter id={`${id}-shadow-sm`} x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="2"  stdDeviation="4"  floodColor="#0F172A" floodOpacity="0.08" />
      </filter>
      <filter id={`${id}-glow`} x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="12" result="blur" />
        <feComposite in="SourceGraphic" in2="blur" operator="over" />
      </filter>

      {/* Card gradients */}
      <linearGradient id={`${id}-card`} x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%"   stopColor="#4F46E5" />
        <stop offset="100%" stopColor="#6D28D9" />
      </linearGradient>
      <linearGradient id={`${id}-teal`} x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%"   stopColor="#14B8A6" />
        <stop offset="100%" stopColor="#0D9488" />
      </linearGradient>
      <linearGradient id={`${id}-bg`} x1="20%" y1="0%" x2="80%" y2="100%">
        <stop offset="0%"   stopColor="#EEF2FF" />
        <stop offset="100%" stopColor="#F0FDFA" />
      </linearGradient>
      <linearGradient id={`${id}-white-card`} x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%"   stopColor="#FFFFFF" />
        <stop offset="100%" stopColor="#F8FAFF" />
      </linearGradient>
      <radialGradient id={`${id}-blob`} cx="50%" cy="50%" r="50%">
        <stop offset="0%"   stopColor="#C7D2FE" stopOpacity="0.5" />
        <stop offset="100%" stopColor="#C7D2FE" stopOpacity="0"   />
      </radialGradient>
      <radialGradient id={`${id}-teal-blob`} cx="50%" cy="50%" r="50%">
        <stop offset="0%"   stopColor="#99F6E4" stopOpacity="0.4" />
        <stop offset="100%" stopColor="#99F6E4" stopOpacity="0"   />
      </radialGradient>

      {/* Shield gradient */}
      <linearGradient id={`${id}-shield`} x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%"   stopColor="#4F46E5" />
        <stop offset="50%"  stopColor="#4338CA" />
        <stop offset="100%" stopColor="#3730A3" />
      </linearGradient>

      {/* Coin gradient */}
      <radialGradient id={`${id}-coin`} cx="35%" cy="35%" r="65%">
        <stop offset="0%"   stopColor="#FDE68A" />
        <stop offset="100%" stopColor="#F59E0B" />
      </radialGradient>
    </defs>
  );
}

// ── Avatar row helper ─────────────────────────────────────────────────────────
function AvatarRow({ x, y, id }: { x: number; y: number; id: string }) {
  const colors = ['#A5B4FC', '#C7D2FE', '#A5B4FC', '#DDD6FE', '#A5B4FC'];
  return (
    <>
      {colors.map((fill, i) => (
        <g key={i}>
          <circle cx={x + i * 32} cy={y}   r={14} fill={fill} />
          <ellipse cx={x + i * 32} cy={y - 5} rx={6} ry={6} fill="#4F46E5" opacity="0.8" />
          <ellipse cx={x + i * 32} cy={y + 7} rx={11} ry={6} fill="#4F46E5" opacity="0.5" />
        </g>
      ))}
      {/* +3 overflow badge */}
      <circle cx={x + 5 * 32} cy={y} r={14} fill="#4F46E5" />
      <text x={x + 5 * 32} y={y + 4} textAnchor="middle" fill="#fff" fontSize="9" fontWeight="700">+3</text>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. PAYROLL HERO ILLUSTRATION
// ─────────────────────────────────────────────────────────────────────────────
export function PayrollHeroIllustration({ width = 480, height = 360 }: IllustrationProps) {
  const id = 'hero';
  return (
    <svg viewBox="0 0 480 360" width={width} height={height} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <Defs id={id} />

      {/* Background blobs */}
      <ellipse cx="240" cy="180" rx="200" ry="160" fill={`url(#${id}-blob)`} />
      <ellipse cx="380" cy="80"  rx="80"  ry="60"  fill={`url(#${id}-teal-blob)`} />

      {/* ── Card stack (depth layers) ── */}
      {/* Layer 3 — deepest, most rotated */}
      <g transform="rotate(8, 200, 200)" filter={`url(#${id}-shadow-sm)`}>
        <rect x="50" y="110" width="300" height="180" rx="20" fill="#312E81" opacity="0.35" />
      </g>
      {/* Layer 2 — middle */}
      <g transform="rotate(4, 200, 200)" filter={`url(#${id}-shadow-sm)`}>
        <rect x="40" y="100" width="300" height="180" rx="20" fill="#3730A3" opacity="0.55" />
      </g>
      {/* Layer 1 — main card */}
      <g filter={`url(#${id}-shadow-lg)`}>
        <rect x="30" y="90" width="300" height="180" rx="20" fill={`url(#${id}-card)`} />

        {/* Card top row: label + badge */}
        <text x="58" y="122" fill="rgba(255,255,255,0.65)" fontSize="10" fontWeight="600" letterSpacing="1.5">PAYROLL</text>
        <rect x="240" y="108" width="68" height="22" rx="11" fill="rgba(255,255,255,0.15)" />
        <text x="274" y="123" textAnchor="middle" fill="#fff" fontSize="9" fontWeight="700">ONCHAIN</text>

        {/* Amount */}
        <text x="58" y="160" fill="#fff" fontSize="28" fontWeight="800" letterSpacing="-0.5">$24,800.00</text>
        <text x="58" y="178" fill="rgba(255,255,255,0.55)" fontSize="11">USDC · Arc Testnet</text>

        {/* Subtle card shimmer line */}
        <line x1="58" y1="195" x2="312" y2="195" stroke="rgba(255,255,255,0.1)" strokeWidth="1" />

        {/* Avatars */}
        <AvatarRow x={58} y={222} id={id} />

        {/* Teal pay button */}
        <g filter={`url(#${id}-shadow-md)`}>
          <rect x="220" y="208" width="90" height="32" rx="16" fill={`url(#${id}-teal)`} />
          <text x="265" y="228" textAnchor="middle" fill="#fff" fontSize="11" fontWeight="700">Pay Now</text>
        </g>
      </g>

      {/* ── Floating stats card (top-right) ── */}
      <g filter={`url(#${id}-shadow-md)`}>
        <rect x="310" y="80" width="148" height="110" rx="16" fill={`url(#${id}-white-card)`} />
        {/* Header bar */}
        <rect x="310" y="80" width="148" height="36" rx="16" fill="#EEF2FF" />
        <rect x="310" y="96" width="148" height="20" fill="#EEF2FF" />
        <text x="384" y="103" textAnchor="middle" fill="#4F46E5" fontSize="10" fontWeight="700">Payroll Summary</text>

        {/* Stat rows */}
        <text x="328" y="130" fill="#64748B" fontSize="9">Employees</text>
        <text x="448" y="130" textAnchor="end" fill="#0F172A" fontSize="11" fontWeight="700">12</text>

        <text x="328" y="148" fill="#64748B" fontSize="9">Avg. salary</text>
        <text x="448" y="148" textAnchor="end" fill="#0F172A" fontSize="11" fontWeight="700">$2,067</text>

        <text x="328" y="166" fill="#64748B" fontSize="9">Status</text>
        <g>
          <circle cx="424" cy="162" r="4" fill="#14B8A6" />
          <text x="432" y="166" fill="#14B8A6" fontSize="9" fontWeight="700">Ready</text>
        </g>

        {/* Mini bar chart */}
        {[40, 55, 35, 65, 50, 72, 60].map((h, i) => (
          <rect key={i} x={318 + i * 14} y={172 + (40 - h * 0.4)} width="9" height={h * 0.4}
            rx="3" fill={i === 5 ? '#4F46E5' : '#C7D2FE'} />
        ))}
      </g>

      {/* ── USDC coin floating ── */}
      <g filter={`url(#${id}-shadow-sm)`}>
        <circle cx="420" cy="225" r="22" fill={`url(#${id}-coin)`} />
        <circle cx="420" cy="225" r="18" fill="none" stroke="#FDE68A" strokeWidth="1.5" strokeOpacity="0.6" />
        <text x="420" y="230" textAnchor="middle" fill="#92400E" fontSize="11" fontWeight="800">$</text>
      </g>

      {/* ── Network nodes (subtle, background) ── */}
      {[
        [420, 300], [460, 330], [390, 340], [450, 280],
      ].map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r={i === 0 ? 7 : 4} fill="#4F46E5" opacity={0.15 + i * 0.04} />
      ))}
      <line x1="420" y1="300" x2="460" y2="330" stroke="#4F46E5" strokeWidth="1" opacity="0.12" />
      <line x1="420" y1="300" x2="390" y2="340" stroke="#4F46E5" strokeWidth="1" opacity="0.12" />
      <line x1="420" y1="300" x2="450" y2="280" stroke="#4F46E5" strokeWidth="1" opacity="0.12" />

      {/* ── Teal accent dot top-left ── */}
      <circle cx="22" cy="90" r="10" fill="#14B8A6" opacity="0.3" />
      <circle cx="38" cy="70" r="6"  fill="#4F46E5"  opacity="0.2" />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. AI AGENT ILLUSTRATION (PNG fallback)
// ─────────────────────────────────────────────────────────────────────────────
export function AgentIllustration({ width = 320, height = 260 }: IllustrationProps) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/images/ai-agent.png" alt="AI Payroll Agent"
      width={typeof width === 'number' ? width : undefined}
      height={typeof height === 'number' ? height : undefined}
      style={{ objectFit: 'contain', maxWidth: '100%', display: 'block' }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. COMPLIANCE ILLUSTRATION
// ─────────────────────────────────────────────────────────────────────────────
export function ComplianceIllustration({ width = 320, height = 250 }: IllustrationProps) {
  const id = 'compliance';
  const checks = [
    { label: 'OFAC Screening',        status: 'pass' },
    { label: 'Address Validation',     status: 'pass' },
    { label: 'Contract Health',        status: 'pass' },
    { label: 'Unusual Transfers',      status: 'warn' },
  ];
  return (
    <svg viewBox="0 0 320 250" width={width} height={height} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <Defs id={id} />

      {/* Background blob */}
      <ellipse cx="160" cy="125" rx="145" ry="115" fill={`url(#${id}-blob)`} />

      {/* ── Shield ── */}
      <g filter={`url(#${id}-glow)`}>
        {/* Shield outer glow ring */}
        <ellipse cx="160" cy="108" rx="70" ry="75" fill="#4F46E5" opacity="0.08" />
      </g>
      <g filter={`url(#${id}-shadow-lg)`}>
        <path d="M160 42 L218 64 L218 112 C218 148 188 170 160 180 C132 170 102 148 102 112 L102 64 Z"
          fill={`url(#${id}-shield)`} />
        {/* Shield inner highlight */}
        <path d="M160 50 L210 70 L210 112 C210 144 183 163 160 172 C137 163 110 144 110 112 L110 70 Z"
          fill="white" opacity="0.07" />
        {/* Checkmark */}
        <path d="M138 112 L154 130 L184 97"
          stroke="white" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
        {/* Inner shield circle */}
        <circle cx="160" cy="113" r="28" fill="white" opacity="0.08" />
      </g>

      {/* ── Score badge ── */}
      <g filter={`url(#${id}-shadow-md)`}>
        <rect x="222" y="48" width="76" height="46" rx="12" fill={`url(#${id}-white-card)`} />
        <text x="260" y="68"  textAnchor="middle" fill="#059669" fontSize="16" fontWeight="800">98</text>
        <text x="260" y="82"  textAnchor="middle" fill="#64748B" fontSize="8"  fontWeight="600">SCORE</text>
      </g>

      {/* ── Checklist rows ── */}
      <g filter={`url(#${id}-shadow-sm)`}>
        <rect x="22" y="188" width="276" height="50" rx="14" fill={`url(#${id}-white-card)`} />
        {checks.slice(0, 2).map((c, i) => (
          <g key={i}>
            <circle cx={42 + i * 138} cy={213} r={8}
              fill={c.status === 'pass' ? '#ECFDF5' : '#FFFBEB'}
              stroke={c.status === 'pass' ? '#059669' : '#D97706'}
              strokeWidth="1.5" />
            {c.status === 'pass'
              ? <path d={`M${36 + i * 138} 213 L${41 + i * 138} 218 L${48 + i * 138} 208`}
                  stroke="#059669" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              : <text x={42 + i * 138} y={217} textAnchor="middle" fill="#D97706" fontSize="8" fontWeight="800">!</text>
            }
            <text x={56 + i * 138} y={214} fill="#0F172A" fontSize="9" fontWeight="600">{c.label}</text>
            <text x={56 + i * 138} y={226} fill={c.status === 'pass' ? '#059669' : '#D97706'} fontSize="8">
              {c.status === 'pass' ? 'Passed' : 'Warning'}
            </text>
          </g>
        ))}
      </g>
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. SCHEDULE ILLUSTRATION
// ─────────────────────────────────────────────────────────────────────────────
export function ScheduleIllustration({ width = 320, height = 250 }: IllustrationProps) {
  const id = 'schedule';
  const days = ['M','T','W','T','F','S','S'];
  const highlighted = new Set([2, 4, 9, 14, 18, 23]);
  return (
    <svg viewBox="0 0 320 250" width={width} height={height} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <Defs id={id} />

      {/* Background */}
      <ellipse cx="160" cy="125" rx="150" ry="115" fill={`url(#${id}-blob)`} />

      {/* ── Floating calendar card ── */}
      {/* Back shadow layer */}
      <g transform="rotate(4, 160, 130)">
        <rect x="35" y="35" width="220" height="195" rx="18" fill="#6D28D9" opacity="0.25" />
      </g>

      <g filter={`url(#${id}-shadow-lg)`}>
        <rect x="28" y="28" width="220" height="195" rx="18" fill={`url(#${id}-white-card)`} />

        {/* Calendar header */}
        <rect x="28" y="28" width="220" height="52" rx="18" fill={`url(#${id}-card)`} />
        <rect x="28" y="58" width="220" height="22" fill={`url(#${id}-card)`} />

        {/* Month title */}
        <text x="138" y="55" textAnchor="middle" fill="rgba(255,255,255,0.9)" fontSize="13" fontWeight="700">Payroll Schedule</text>

        {/* Day headers */}
        {days.map((d, i) => (
          <text key={i} x={52 + i * 28} y={94} textAnchor="middle"
            fill={i >= 5 ? '#A5B4FC' : '#64748B'} fontSize="9" fontWeight="700">{d}</text>
        ))}

        {/* Calendar grid */}
        {Array.from({ length: 28 }, (_, k) => {
          const row = Math.floor(k / 7);
          const col = k % 7;
          const isHighlighted = highlighted.has(k);
          const isTeal = k === 4 || k === 14;
          return (
            <g key={k}>
              <rect x={38 + col * 28} y={100 + row * 24} width="20" height="20" rx="6"
                fill={isTeal ? '#14B8A6' : isHighlighted ? '#4F46E5' : 'transparent'}
                opacity={isHighlighted ? 1 : 0.5} />
              <text x={48 + col * 28} y={114 + row * 24} textAnchor="middle"
                fill={isHighlighted ? '#fff' : '#94A3B8'} fontSize="8" fontWeight={isHighlighted ? '700' : '400'}>
                {k + 1}
              </text>
            </g>
          );
        })}
      </g>

      {/* ── Clock badge (top-right overlap) ── */}
      <g filter={`url(#${id}-shadow-md)`}>
        <circle cx="255" cy="68" r="32" fill={`url(#${id}-white-card)`} />
        <circle cx="255" cy="68" r="26" fill="none" stroke="#EEF2FF" strokeWidth="2" />
        {/* Clock hands */}
        <line x1="255" y1="68" x2="255" y2="47" stroke="#4F46E5" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="255" y1="68" x2="272" y2="72" stroke="#14B8A6" strokeWidth="2" strokeLinecap="round" />
        <circle cx="255" cy="68" r="3.5" fill="#4F46E5" />
        {/* 12 o'clock tick */}
        <line x1="255" y1="44" x2="255" y2="48" stroke="#C7D2FE" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="268" y1="47" x2="266" y2="50" stroke="#C7D2FE" strokeWidth="1" strokeLinecap="round" />
        <line x1="242" y1="47" x2="244" y2="50" stroke="#C7D2FE" strokeWidth="1" strokeLinecap="round" />
      </g>

      {/* ── Repeat badge ── */}
      <g filter={`url(#${id}-shadow-sm)`}>
        <rect x="258" y="170" width="52" height="26" rx="13" fill={`url(#${id}-teal)`} />
        <text x="284" y="187" textAnchor="middle" fill="#fff" fontSize="9" fontWeight="700">Weekly</text>
      </g>
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. LOGIN / OTP ILLUSTRATION
// ─────────────────────────────────────────────────────────────────────────────
export function LoginIllustration({ width = 300, height = 240 }: IllustrationProps) {
  const id = 'login';
  return (
    <svg viewBox="0 0 300 240" width={width} height={height} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <Defs id={id} />

      {/* Background soft blob */}
      <ellipse cx="150" cy="120" rx="135" ry="110" fill={`url(#${id}-blob)`} />

      {/* ── Envelope body ── */}
      <g filter={`url(#${id}-shadow-lg)`}>
        {/* Envelope base */}
        <rect x="50" y="60" width="200" height="130" rx="16" fill={`url(#${id}-card)`} />
        {/* Envelope flap (V fold) */}
        <path d="M50 76 L150 140 L250 76 L250 60 L50 60 Z" fill="#6D28D9" opacity="0.5" />
        <path d="M50 76 L150 140 L250 76" stroke="rgba(255,255,255,0.2)" strokeWidth="1" fill="none" />
        {/* Letter sheet peeking out */}
        <rect x="92" y="45" width="116" height="90" rx="8" fill={`url(#${id}-white-card)`} filter={`url(#${id}-shadow-sm)`} />
        <rect x="104" y="58" width="60" height="5" rx="2.5" fill="#C7D2FE" />
        <rect x="104" y="69" width="92" height="5" rx="2.5" fill="#E2E8F0" />
        <rect x="104" y="80" width="80" height="5" rx="2.5" fill="#E2E8F0" />
        {/* Glowing @ symbol */}
        <text x="185" y="92" textAnchor="middle" fill="#4F46E5" fontSize="22" fontWeight="800" opacity="0.9">@</text>
      </g>

      {/* ── OTP code boxes ── */}
      <g filter={`url(#${id}-shadow-sm)`}>
        {[0,1,2,3,4,5].map(i => (
          <g key={i}>
            <rect x={34 + i * 40} y={178} width="32" height="38" rx="10"
              fill={i < 3 ? `url(#${id}-card)` : `url(#${id}-white-card)`}
              stroke={i < 3 ? 'none' : '#E2E8F0'}
              strokeWidth="1.5" />
            {i < 3 && (
              <text x={50 + i * 40} y={202} textAnchor="middle"
                fill="rgba(255,255,255,0.9)" fontSize="16" fontWeight="800">•</text>
            )}
            {i === 3 && (
              <rect x={48 + i * 40} y={190} width="2" height="18" rx="1" fill="#4F46E5" opacity="0.8">
                <animate attributeName="opacity" values="1;0;1" dur="1.2s" repeatCount="indefinite" />
              </rect>
            )}
          </g>
        ))}
      </g>
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. ADD EMPLOYEES ILLUSTRATION
// ─────────────────────────────────────────────────────────────────────────────
export function AddEmployeesIllustration({ width = 320, height = 240 }: IllustrationProps) {
  const id = 'add-emp';
  const rows = [
    { name: 'Alice Chen',   dept: 'Engineering', amount: '$4,200', color: '#A5B4FC' },
    { name: 'James Obi',    dept: 'Legal',        amount: '$3,800', color: '#C7D2FE' },
    { name: 'Sara Müller',  dept: 'Remote',       amount: '$3,200', color: '#A5B4FC' },
  ];
  return (
    <svg viewBox="0 0 320 240" width={width} height={height} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <Defs id={id} />

      {/* Background */}
      <ellipse cx="160" cy="120" rx="150" ry="110" fill={`url(#${id}-blob)`} />

      {/* ── Table card ── */}
      <g filter={`url(#${id}-shadow-md)`}>
        <rect x="20" y="20" width="280" height="185" rx="16" fill={`url(#${id}-white-card)`} />

        {/* Table header */}
        <rect x="20" y="20" width="280" height="38" rx="16" fill={`url(#${id}-card)`} />
        <rect x="20" y="42" width="280" height="16" fill={`url(#${id}-card)`} />
        <text x="48"  y="43" fill="rgba(255,255,255,0.7)" fontSize="9" fontWeight="600">NAME</text>
        <text x="146" y="43" fill="rgba(255,255,255,0.7)" fontSize="9" fontWeight="600">DEPT</text>
        <text x="250" y="43" fill="rgba(255,255,255,0.7)" fontSize="9" fontWeight="600">SALARY</text>

        {/* Table rows */}
        {rows.map((r, i) => (
          <g key={i}>
            {i > 0 && <line x1="36" y1={70 + i * 44} x2="284" y2={70 + i * 44} stroke="#F1F5F9" strokeWidth="1" />}
            <circle cx="44" cy={88 + i * 44} r="12" fill={r.color} />
            <ellipse cx="44" cy={84 + i * 44} rx={5} ry={5} fill="#4F46E5" opacity="0.7" />
            <ellipse cx="44" cy={94 + i * 44} rx={10} ry={5} fill="#4F46E5" opacity="0.4" />
            <text x="64" y={86 + i * 44} fill="#0F172A" fontSize="10" fontWeight="600">{r.name}</text>
            <text x="64" y={97 + i * 44} fill="#94A3B8" fontSize="8">{r.dept}</text>
            <rect x="235" y={79 + i * 44} width="50" height="18" rx="8" fill="#EEF2FF" />
            <text x="260" y={92 + i * 44} textAnchor="middle" fill="#4F46E5" fontSize="9" fontWeight="700">{r.amount}</text>
          </g>
        ))}
      </g>

      {/* ── Add button ── */}
      <g filter={`url(#${id}-shadow-md)`}>
        <rect x="100" y="192" width="120" height="36" rx="18" fill={`url(#${id}-teal)`} />
        <line x1="148" y1="210" x2="172" y2="210" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="160" y1="198" x2="160" y2="222" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" />
        <text x="173" y="214" fill="#fff" fontSize="10" fontWeight="700">Add</text>
      </g>
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. TRANSACTION ILLUSTRATION
// ─────────────────────────────────────────────────────────────────────────────
export function TransactionIllustration({ width = 300, height = 240 }: IllustrationProps) {
  const id = 'tx';
  const chartPts = [[40,150],[75,118],[110,132],[145,98],[180,108],[215,76],[250,90],[285,65]];
  const polyline = chartPts.map(([x, y]) => `${x},${y}`).join(' ');
  const area     = `${chartPts[0][0]},170 ${polyline} ${chartPts[chartPts.length-1][0]},170`;
  return (
    <svg viewBox="0 0 320 240" width={width} height={height} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <Defs id={id} />
      <defs>
        <linearGradient id={`${id}-area`} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%"   stopColor="#4F46E5" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#4F46E5" stopOpacity="0"    />
        </linearGradient>
      </defs>

      <ellipse cx="160" cy="120" rx="150" ry="110" fill={`url(#${id}-blob)`} />

      <g filter={`url(#${id}-shadow-md)`}>
        <rect x="20" y="20" width="280" height="200" rx="16" fill={`url(#${id}-white-card)`} />

        {/* Chart area */}
        <polygon points={area} fill={`url(#${id}-area)`} />
        <polyline points={polyline} stroke="#4F46E5" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        {/* Active dot */}
        <circle cx="215" cy="76" r="5" fill="#4F46E5" />
        <circle cx="215" cy="76" r="9" fill="#4F46E5" opacity="0.15" />

        {/* Tooltip */}
        <rect x="196" y="52" width="72" height="26" rx="8" fill="#4F46E5" />
        <text x="232" y="69" textAnchor="middle" fill="#fff" fontSize="10" fontWeight="700">$21,400</text>

        {/* Row items */}
        {[
          { name: 'Batch #047', amount: '+$8,400', status: 'success' },
          { name: 'Batch #046', amount: '+$9,200', status: 'success' },
        ].map((r, i) => (
          <g key={i}>
            <rect x="28" y={175 + i * 32} width="264" height="26" rx="8"
              fill={i % 2 === 0 ? '#F8F9FA' : 'transparent'} />
            <circle cx="48" cy={188 + i * 32} r="8" fill={i === 0 ? '#A5B4FC' : '#C7D2FE'} />
            <text x="64" y={191 + i * 32} fill="#0F172A" fontSize="9" fontWeight="600">{r.name}</text>
            <rect x="230" y={181 + i * 32} width="52" height="16" rx="6" fill="#ECFDF5" />
            <text x="256" y={193 + i * 32} textAnchor="middle" fill="#059669" fontSize="8" fontWeight="700">{r.amount}</text>
          </g>
        ))}
      </g>
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// REMAINING ILLUSTRATIONS (Settings, Pricing, Error, Empty) — refined versions
// ─────────────────────────────────────────────────────────────────────────────

export function EmptyIllustration({ width = 260, height = 200, label = 'No data yet' }: IllustrationProps & { label?: string }) {
  const id = 'empty';
  return (
    <svg viewBox="0 0 260 200" width={width} height={height} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <Defs id={id} />
      <ellipse cx="130" cy="100" rx="120" ry="90" fill={`url(#${id}-blob)`} />
      <g filter={`url(#${id}-shadow-md)`}>
        <rect x="55" y="30" width="150" height="110" rx="16" fill={`url(#${id}-white-card)`} />
        <rect x="55" y="30" width="150" height="38" rx="16" fill={`url(#${id}-card)`} />
        <rect x="55" y="52" width="150" height="16" fill={`url(#${id}-card)`} />
        <text x="130" y="52" textAnchor="middle" fill="rgba(255,255,255,0.8)" fontSize="10" fontWeight="700">No Records</text>
        <text x="130" y="100" textAnchor="middle" fill="#C7D2FE" fontSize="40" fontWeight="800" opacity="0.6">?</text>
      </g>
      <rect x="65" y="152" width="130" height="24" rx="12" fill={`url(#${id}-card)`} opacity="0.12" />
      <text x="130" y="168" textAnchor="middle" fill="#4F46E5" fontSize="11" fontWeight="600" opacity="0.7">{label}</text>
    </svg>
  );
}

export function PricingIllustration({ width = 280, height = 200 }: IllustrationProps) {
  const id = 'pricing';
  return (
    <svg viewBox="0 0 280 200" width={width} height={height} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <Defs id={id} />
      <ellipse cx="140" cy="100" rx="130" ry="90" fill={`url(#${id}-blob)`} />
      <g filter={`url(#${id}-shadow-lg)`}>
        <rect x="60" y="25" width="160" height="145" rx="18" fill={`url(#${id}-card)`} />
        <rect x="80" y="45" width="120" height="32" rx="10" fill="rgba(255,255,255,0.1)" />
        <text x="140" y="66" textAnchor="middle" fill="#fff" fontSize="13" fontWeight="800">Premium</text>
        <text x="140" y="100" textAnchor="middle" fill="#fff" fontSize="28" fontWeight="800">$10</text>
        <text x="140" y="115" textAnchor="middle" fill="rgba(255,255,255,0.6)" fontSize="9">ONE-TIME</text>
        {['Private Contract', 'AI Agent', '1,000 per batch', 'Multi-token'].map((f, i) => (
          <g key={i}>
            <circle cx="88" cy={132 + i * 18} r="5" fill="#14B8A6" />
            <path d={`M85 ${132 + i * 18} L88 ${135 + i * 18} L93 ${129 + i * 18}`}
              stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <text x="100" y={136 + i * 18} fill="rgba(255,255,255,0.85)" fontSize="9">{f}</text>
          </g>
        ))}
      </g>
    </svg>
  );
}

export function SettingsIllustration({ width = 280, height = 200 }: IllustrationProps) {
  const id = 'settings';
  return (
    <svg viewBox="0 0 280 200" width={width} height={height} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <Defs id={id} />
      <ellipse cx="140" cy="100" rx="130" ry="90" fill={`url(#${id}-blob)`} />
      <g filter={`url(#${id}-shadow-md)`}>
        <circle cx="130" cy="105" r="42" fill={`url(#${id}-card)`} />
        <circle cx="130" cy="105" r="22" fill="white" opacity="0.15" />
        <circle cx="130" cy="105" r="10" fill="white" opacity="0.25" />
        {[0,45,90,135,180,225,270,315].map((a, i) => (
          <rect key={i} x="126" y="57" width="8" height="14" rx="4" fill={`url(#${id}-card)`}
            transform={`rotate(${a} 130 105)`} />
        ))}
      </g>
      <g filter={`url(#${id}-shadow-sm)`}>
        <circle cx="196" cy="68" r="26" fill="#818CF8" />
        <circle cx="196" cy="68" r="12" fill="white" opacity="0.15" />
        {[0,60,120,180,240,300].map((a, i) => (
          <rect key={i} x="193" y="44" width="6" height="10" rx="3" fill="#818CF8"
            transform={`rotate(${a} 196 68)`} />
        ))}
      </g>
    </svg>
  );
}

export function ErrorIllustration({ code = '404', width = 340, height = 260 }: IllustrationProps & { code?: string }) {
  const id = 'error';
  return (
    <svg viewBox="0 0 340 260" width={width} height={height} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <Defs id={id} />
      <ellipse cx="170" cy="130" rx="155" ry="120" fill={`url(#${id}-blob)`} />
      <g filter={`url(#${id}-shadow-lg)`}>
        <rect x="90" y="155" width="160" height="64" rx="16" fill={`url(#${id}-card)`} />
        <text x="170" y="197" textAnchor="middle" fill="white" fontSize="32" fontWeight="800" fontFamily="monospace">{code}</text>
      </g>
      <circle cx="170" cy="108" r="38" fill="#EEF2FF" />
      <circle cx="170" cy="96"  r="18" fill="#4F46E5" opacity="0.8" />
      <ellipse cx="170" cy="122" rx="30" ry="16" fill="#4F46E5" opacity="0.5" />
      <text x="115" y="95" fill="#4F46E5" fontSize="22" fontWeight="800" opacity="0.3">?</text>
      <text x="215" y="85" fill="#4F46E5" fontSize="16" fontWeight="800" opacity="0.25">?</text>
    </svg>
  );
}
