/* Shared seed-phrase filters, used by the per-account Seeds tab and the
 * cross-account All/Seeds view so both always offer the same controls. */

export const SEED_TIERS = [
  { id: "", label: "All" },
  { id: "valid", label: "Checksum valid" },
  { id: "low", label: "3–4 low" },
  { id: "minimum", label: "5–7 minimum" },
  { id: "medium", label: "8–11 medium" },
  { id: "high", label: "12+ high" },
];

export const SEED_CHECKSUMS = [
  { id: "", label: "Any checksum" },
  { id: "valid", label: "Valid" },
  { id: "failed", label: "Failed" },
];

export const SEED_WORD_COUNTS = [
  { id: 0, label: "All lengths" },
  { id: 12, label: "12" },
  { id: 15, label: "15" },
  { id: 18, label: "18" },
  { id: 21, label: "21" },
  { id: 24, label: "24" },
];

export function Chip({ active, onClick, children, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`h-8 rounded-full px-3 text-[12px] font-medium ${
        active
          ? "bg-[#1d1d1f] text-white"
          : "border border-[#d2d2d7] bg-white text-[#424245] hover:bg-[#fafafa]"
      }`}
    >
      {children}
    </button>
  );
}

export function FilterRow({ label, children }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-[74px] shrink-0 text-[10px] font-medium uppercase tracking-[0.05em] text-[#6e6e73]">
        {label}
      </span>
      {children}
    </div>
  );
}

export function SeedFilterBar({
  tier,
  setTier,
  checksum,
  setChecksum,
  words,
  setWords,
  spamHidden = 0,
  showSpam,
  setShowSpam,
  extra = null,
}) {
  return (
    <div className="space-y-2">
      <FilterRow label="Checksum">
        {SEED_CHECKSUMS.map((option) => (
          <Chip
            key={`c-${option.id}`}
            active={checksum === option.id}
            onClick={() => setChecksum(option.id)}
          >
            {option.label}
          </Chip>
        ))}
      </FilterRow>

      <FilterRow label="Tier">
        {SEED_TIERS.map((option) => (
          <Chip key={`t-${option.id}`} active={tier === option.id} onClick={() => setTier(option.id)}>
            {option.label}
          </Chip>
        ))}
      </FilterRow>

      <FilterRow label="Height">
        {SEED_WORD_COUNTS.map((option) => (
          <Chip key={`w-${option.id}`} active={words === option.id} onClick={() => setWords(option.id)}>
            {option.label}
          </Chip>
        ))}
        {setShowSpam ? (
          <button
            type="button"
            onClick={() => setShowSpam((value) => !value)}
            className={`ml-1 h-8 rounded-full px-3 text-[12px] font-medium ${
              showSpam ? "bg-[#fff8e6] text-[#8a6100]" : "border border-[#d2d2d7] bg-white text-[#424245]"
            }`}
            title="Repeated-word phrases, HTML/CSS selectors and document text that is not a BIP39 seed."
          >
            {showSpam ? `Showing spam (${spamHidden})` : `Spam hidden (${spamHidden})`}
          </button>
        ) : null}
        {extra}
      </FilterRow>
    </div>
  );
}
