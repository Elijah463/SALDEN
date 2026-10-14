'use client';
/**
 * Fiat onramp is not live yet, so this is a placeholder with the same export and
 * props as before. Existing callers keep compiling and nothing loads the Circle
 * onramp package.
 */

type OnrampWidgetProps = {
  session?: unknown;
  onComplete?: (amount: number, info: unknown) => void;
  onClose?: () => void;
  onNeedsNewSession?: (reason: string) => void;
};

export function OnrampWidget(_props: OnrampWidgetProps) {
  return (
    <p style={{ fontSize: 14, color: '#475569' }}>
      Fiat deposits are coming soon.
    </p>
  );
}
