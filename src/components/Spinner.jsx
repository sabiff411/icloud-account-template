const NIB_DELAY_CLASSES = [
  "before:[animation-delay:-0.8s]",
  "before:[animation-delay:-0.7s]",
  "before:[animation-delay:-0.6s]",
  "before:[animation-delay:-0.5s]",
  "before:[animation-delay:-0.4s]",
  "before:[animation-delay:-0.3s]",
  "before:[animation-delay:-0.2s]",
  "before:[animation-delay:-0.1s]",
];

export function NibSpinner({ className = "" }) {
  return (
    <div className={`relative h-0 w-0 scale-[.15] ${className}`} aria-hidden="true">
      {NIB_DELAY_CLASSES.map((delayClass, i) => (
        <i
          key={i}
          className={`absolute -top-[12.5px] left-0 h-[28px] w-[66px] origin-left rounded-[25%/50%] before:block before:h-full before:w-full before:animate-nib-fade before:rounded-[25%/50%] before:bg-black ${delayClass}`}
          style={{ transform: `rotate(${i * 45}deg) translateX(40px)` }}
        />
      ))}
    </div>
  );
}

export function LoadingVeil() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Signing in"
      className="tk-load fixed inset-0 z-[2147483646] flex cursor-progress select-none items-center justify-center bg-[rgba(255,255,255,0.82)] opacity-0 [backdrop-filter:saturate(180%)_blur(10px)] animate-veil-in motion-reduce:animate-none motion-reduce:opacity-100"
    >
      <NibSpinner />
    </div>
  );
}
